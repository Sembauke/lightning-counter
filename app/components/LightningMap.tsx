'use client';

import { useEffect, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import type { Strike } from '../hooks/useBlitzortung';
import { useHeatmap, type HeatmapWindow } from '../context/HeatmapContext';

interface FlashRing {
  lat: number;
  lon: number;
  startTime: number;
  zoomed: boolean;
}

interface HeatPoint {
  lat: number;
  lon: number;
  time: number;
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
  layer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tileLayer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  labelsLayer: any;
  markers: Map<string, { marker: any; addedAt: number }>;
  processed: Set<string>;
  styleInterval: ReturnType<typeof setInterval> | null;
  heatmapTimer: ReturnType<typeof setInterval> | null;
  rings: FlashRing[];
  rafId: number | null;
  ready: boolean;
  heatCanvas: HTMLCanvasElement | null;
  heatCtx: CanvasRenderingContext2D | null;
  dpr: number;
  drawHeatmap: (() => void) | null;
}

function getMarkerStyle(ageMs: number) {
  if (ageMs < 10_000)  return { radius: 4, fillColor: '#ffe040', color: '#ff2222', fillOpacity: 1,    opacity: 0.9, weight: 1.5 };
  if (ageMs < 60_000)  return { radius: 3, fillColor: '#ffff00', color: '#ffff00', fillOpacity: 0.95, opacity: 0,   weight: 0 };
  if (ageMs < 300_000) return { radius: 3, fillColor: '#ffcc00', color: '#ffcc00', fillOpacity: 0.8,  opacity: 0,   weight: 0 };
  if (ageMs < 900_000) return { radius: 2, fillColor: '#ff8800', color: '#ff8800', fillOpacity: 0.65, opacity: 0,   weight: 0 };
  const fadeT = Math.min((ageMs - 900_000) / 900_000, 1);
  return { radius: 2, fillColor: '#ff4400', color: '#ff4400', fillOpacity: 0.45 * (1 - fadeT), opacity: 0, weight: 0 };
}

// Stepped grid levels: displayPx = visual cell size; binZoom = Mercator zoom used for binning.
// Within a group (e.g. z10-z12) binZoom is fixed so geographic detail doesn't increase with zoom.
function getHeatmapLevel(zoom: number): { displayPx: number; binZoom: number } {
  const z = Math.floor(zoom);
  if (z >= 9) return { displayPx: 24, binZoom: 9 };
  return { displayPx: Math.min(24 * (1 << (9 - z)), 192), binZoom: Math.max(z, 2) };
}

// Logarithmic color scale: blue (sparse) → cyan → green → yellow → orange → red (dense)
function getHeatColor(count: number, maxCount: number): string {
  if (!count || !maxCount) return 'rgba(0,0,0,0)';
  const t = Math.min(Math.log1p(count) / Math.log1p(Math.max(maxCount, 1)), 1);
  // Color stops: [position, r, g, b, alpha]
  type Stop = [number, number, number, number, number];
  const stops: Stop[] = [
    [0,    0,  40, 220, 0.15],
    [0.20, 0, 180, 255, 0.28],
    [0.45, 60, 230, 100, 0.38],
    [0.65, 255, 220,   0, 0.48],
    [0.82, 255,  80,   0, 0.56],
    [1.0,  255,  20,  20, 0.65],
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
  '1w':  7 * 24 * 60 * 60 * 1000,
};

const WINDOW_LABELS: Record<HeatmapWindow, string> = {
  '30m': '30 min',
  '1h':  '1 hr',
  '3h':  '3 hrs',
  '1d':  '1 day',
  '1w':  '1 week',
};

const FIXED_BIN_ZOOM = 9;
const FIXED_DISPLAY_PX = 24;
const FIXED_KEY_MULT = 1 << 15;

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
  const heatmapEnabledRef = useRef(heatmapEnabled);
  heatmapEnabledRef.current = heatmapEnabled;
  const timeWindowRef = useRef(timeWindow);
  timeWindowRef.current = timeWindow;

  // Long-lived buffer for heatmap — accumulates all strikes (max 7d, capped at 100k)
  const heatmapBufferRef = useRef<HeatPoint[]>([]);
  // Historical strikes fetched from DB for the current viewport
  const dbBufferRef = useRef<HeatPoint[]>([]);
  const viewportFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchViewportRef = useRef<(() => void) | null>(null);
  const fixedGridRef = useRef<Map<number, HeatPoint[]>>(new Map());
  const lastDragEndRef = useRef(0);
  const isSelectingRef = useRef(false);
  const selectStartRef = useRef<{ x: number; y: number } | null>(null);
  const selectRectRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);

  const [selectedCell, setSelectedCell] = useState<CellData | null>(null);
  const selectedCellRef = useRef<{ col: number; row: number; binZoom: number; displayPx: number; bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number } } | null>(null);
  const [showDots, setShowDots] = useState(false);
  const showDotsRef = useRef(false);
  const dotsRafRef = useRef<number | null>(null);
  const dotsAnimStartRef = useRef(0);
  const manualScrubRef = useRef<number | null>(null); // 0–1 when user is dragging
  const scrubberRef = useRef<HTMLInputElement>(null);
  const [apiData, setApiData] = useState<{
    strikes: Array<{ id: number; strike_time: number; lat: number; lon: number }>;
    total: number; page: number; pages: number;
  } | null>(null);
  const [apiLoading, setApiLoading] = useState(false);


  const fetchViewport = () => {
    const s = stateRef.current;
    if (!s.map || !heatmapEnabledRef.current) return;
    const b = s.map.getBounds();
    const since = Date.now() - WINDOW_MS[timeWindowRef.current];
    const q = `minLat=${b.getSouth()}&maxLat=${b.getNorth()}&minLon=${b.getWest()}&maxLon=${b.getEast()}&since=${since}`;
    fetch(`/api/grid/viewport?${q}`)
      .then(r => r.json())
      .then(data => {
        dbBufferRef.current = (data.strikes as Array<{ lat: number; lon: number; strike_time: number }>)
          .map(s => ({ lat: s.lat, lon: s.lon, time: s.strike_time }));
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
    map: null, layer: null, renderer: null, tileLayer: null, labelsLayer: null,
    markers: new Map(), processed: new Set(),
    styleInterval: null, heatmapTimer: null,
    rings: [], rafId: null, ready: false,
    heatCanvas: null, heatCtx: null, dpr: 1, drawHeatmap: null,
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

      map.on('moveend zoomend', () => {
        const c = map.getCenter();
        const z = map.getZoom();
        localStorage.setItem('mapView', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: z }));
        setZoom(z);
        s.drawHeatmap?.();
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

      s.renderer = L.canvas({ padding: 0.5 });
      s.layer = L.layerGroup().addTo(map);
      s.map = map;

      const dpr = window.devicePixelRatio || 1;
      s.dpr = dpr;

      // ── Heatmap canvas (z-index 400, drawn below strike rings) ──
      const heatCanvas = document.createElement('canvas');
      heatCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:400;';
      container.appendChild(heatCanvas);
      s.heatCanvas = heatCanvas;
      s.heatCtx = heatCanvas.getContext('2d')!;

      // ── Strike ring overlay canvas (z-index 450) ──
      const overlay = document.createElement('canvas');
      overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:450;';
      container.appendChild(overlay);

      const sizeCanvases = () => {
        const w = container.offsetWidth * dpr;
        const h = container.offsetHeight * dpr;
        overlay.width = w;   overlay.height = h;
        heatCanvas.width = w; heatCanvas.height = h;
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
        if (!heatmapEnabledRef.current) return;

        const zoom = s.map.getZoom();
        const { displayPx, binZoom } = getHeatmapLevel(zoom);
        const KEY_MULT = 1 << 15; // safe for all binZoom levels

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
        const binPoint = (pt: HeatPoint) => {
          if (pt.time < cutoff) return;
          const p = s.map!.project([pt.lat, pt.lon], binZoom);
          const col = Math.floor(p.x / displayPx);
          const row = Math.floor(p.y / displayPx);
          if (col < colMin || col > colMax || row < rowMin || row > rowMax) return;
          const key = row * KEY_MULT + col;
          const n = (grid.get(key) ?? 0) + 1;
          grid.set(key, n);
          if (n > maxCount) maxCount = n;
        };
        for (const pt of heatmapBufferRef.current) binPoint(pt);
        for (const pt of dbBufferRef.current) binPoint(pt);

        hCtx.save();
        hCtx.scale(dpr, dpr);

        if (!showDotsRef.current) {
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
        }

        // 3) Grid lines — projected from bin boundaries (matches the cell size on screen)
        hCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
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
          if (showDotsRef.current) {
            hCtx.fillStyle = 'rgba(0, 0, 0, 0.45)';
            hCtx.fillRect(sx, sy, sw2, sh);
          }
          hCtx.strokeStyle = 'rgba(255, 220, 0, 0.95)';
          hCtx.lineWidth = 2 / dpr;
          hCtx.strokeRect(sx + 1 / dpr, sy + 1 / dpr, sw2 - 2 / dpr, sh - 2 / dpr);

          // 5) Animated strike dots — replay 1h of strikes in compressed time (20s loop)
          if (showDotsRef.current) {
            const ANIM_MS   = 20_000;           // 20s real-time per loop
            const DATA_MS   = 60 * 60 * 1000;  // 1 hour of data
            const TRAIL_MS  = DATA_MS;           // dots stay visible for the full hour
            const dotR      = Math.max(3, 5 / dpr);

            const wallNow   = Date.now();
            const manual    = manualScrubRef.current;
            const progress  = manual !== null
              ? manual
              : ((wallNow - dotsAnimStartRef.current) % ANIM_MS) / ANIM_MS;
            const dataStart = wallNow - DATA_MS;
            const playhead  = dataStart + progress * DATA_MS;

            // Update scrubber position directly (no React re-render)
            if (scrubberRef.current && manual === null) {
              scrubberRef.current.value = String(Math.round(progress * 1000));
            }

            const { minLat, maxLat, minLon, maxLon } = sel.bounds;

            for (const buf of [heatmapBufferRef.current, dbBufferRef.current]) {
              for (const pt of buf) {
                if (pt.time < dataStart) continue;
                if (pt.lat < minLat || pt.lat > maxLat || pt.lon < minLon || pt.lon > maxLon) continue;
                const simAge = playhead - pt.time;
                if (simAge < 0 || simAge > TRAIL_MS) continue;
                const t = 1 - simAge / TRAIL_MS; // 1 = newest, 0 = oldest
                // Color: newest = bright green, oldest = blue-purple
                const r = Math.round(t < 0.5 ? 80 : 80 + (t - 0.5) * 2 * 60);
                const g = Math.round(80 + t * 175);
                const b = Math.round(t < 0.5 ? 220 - t * 2 * 120 : 100);
                const a = (0.35 + t * 0.65).toFixed(2);
                hCtx.fillStyle = `rgba(${r},${g},${b},${a})`;
                const dp = s.map.latLngToContainerPoint([pt.lat, pt.lon]);
                hCtx.beginPath();
                hCtx.arc(dp.x, dp.y, dotR * (0.4 + 0.6 * t), 0, Math.PI * 2);
                hCtx.fill();
              }
            }
          }
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

        // Rebuild fixed-grid lookup for click detection
        const cutoff2 = Date.now() - WINDOW_MS[timeWindowRef.current];
        const cells = new Map<number, HeatPoint[]>();
        for (const pt of heatmapBufferRef.current) {
          if (pt.time < cutoff2) continue;
          const p = s.map!.project([pt.lat, pt.lon], FIXED_BIN_ZOOM);
          const col = Math.floor(p.x / FIXED_DISPLAY_PX);
          const row = Math.floor(p.y / FIXED_DISPLAY_PX);
          if (col < 0 || col >= FIXED_KEY_MULT || row < 0 || row >= FIXED_KEY_MULT) continue;
          const key = row * FIXED_KEY_MULT + col;
          const arr = cells.get(key);
          if (arr) arr.push(pt);
          else cells.set(key, [pt]);
        }
        fixedGridRef.current = cells;
      };

      // Refresh heatmap every 5 seconds to pick up new strikes
      s.heatmapTimer = setInterval(() => s.drawHeatmap?.(), 5_000);

      // ── Ring animation RAF loop ──
      const ctx = overlay.getContext('2d')!;
      const drawRings = (now: number) => {
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        if (s.rings.length > 0) {
          ctx.save();
          ctx.scale(dpr, dpr);

          const zoom = map.getZoom();
          const metersPerPx = 156_543 / Math.pow(2, zoom);
          const soundMaxPx = Math.max(160, Math.min(600, Math.round(25_000 / metersPerPx)));

          let i = s.rings.length;
          while (i--) {
            const ring = s.rings[i];
            if (ring.zoomed) {
              if (zoom < 11) continue;
              const p = Math.min((now - ring.startTime) / 73_000, 1);
              if (p >= 1) { s.rings.splice(i, 1); continue; }
              const pt = map.latLngToContainerPoint([ring.lat, ring.lon]);
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, Math.max(1, soundMaxPx * p), 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(255,255,255,${(Math.pow(1 - p, 2) * 0.85).toFixed(3)})`;
              ctx.lineWidth = 0.5 + (1 - p) * 2.5;
              ctx.stroke();
            } else {
              if (zoom >= 11) continue;
              const p = Math.min((now - ring.startTime) / 600, 1);
              if (p >= 1) { s.rings.splice(i, 1); continue; }
              const pt = map.latLngToContainerPoint([ring.lat, ring.lon]);
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, Math.max(1, Math.sqrt(p) * 40), 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(255,220,60,${(Math.pow(1 - p, 1.5) * 0.95).toFixed(3)})`;
              ctx.lineWidth = 2.5 * (1 - p) + 0.5;
              ctx.stroke();
            }
          }

          ctx.restore();
        }

        s.rafId = requestAnimationFrame(drawRings);
      };
      s.rafId = requestAnimationFrame(drawRings);

      const refreshMarkers = () => {
        const now = Date.now();
        const toRemove: string[] = [];
        s.markers.forEach((entry, id) => {
          const age = now - entry.addedAt;
          if (age > 30 * 60 * 1000) { toRemove.push(id); return; }
          const style = getMarkerStyle(age);
          entry.marker.setStyle({
            fillColor: style.fillColor, color: style.color,
            fillOpacity: style.fillOpacity, opacity: style.opacity, weight: style.weight,
          });
          entry.marker.setRadius(style.radius);
        });
        toRemove.forEach(id => {
          const entry = s.markers.get(id);
          if (entry) { s.layer.removeLayer(entry.marker); s.markers.delete(id); s.processed.delete(id); }
        });
      };

      s.styleInterval = setInterval(refreshMarkers, 2000);
      map.on('zoomend', refreshMarkers);
      s.ready = true;

      // Seed heatmap from DB on load if already enabled
      if (heatmapEnabledRef.current) {
        fetchViewportRef.current?.();
      }
    });

    return () => {
      const s = stateRef.current;
      if (s.styleInterval) clearInterval(s.styleInterval);
      if (s.heatmapTimer) clearInterval(s.heatmapTimer);
      if (s.rafId !== null) cancelAnimationFrame(s.rafId);
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

      const { binZoom, displayPx } = getHeatmapLevel(s.map.getZoom());
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

      const { binZoom, displayPx } = getHeatmapLevel(s.map.getZoom());
      setShowDots(false);
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

  useEffect(() => {
    showDotsRef.current = showDots;

    // Stop any existing animation loop
    if (dotsRafRef.current !== null) {
      cancelAnimationFrame(dotsRafRef.current);
      dotsRafRef.current = null;
    }

    if (showDots) {
      dotsAnimStartRef.current = Date.now();
      let lastFrame = 0;
      const tick = (now: number) => {
        // ~20 fps — enough for smooth dot animation without hammering the canvas
        if (now - lastFrame >= 50) {
          lastFrame = now;
          stateRef.current.drawHeatmap?.();
        }
        dotsRafRef.current = requestAnimationFrame(tick);
      };
      dotsRafRef.current = requestAnimationFrame(tick);
    } else {
      stateRef.current.drawHeatmap?.();
    }

    return () => {
      if (dotsRafRef.current !== null) {
        cancelAnimationFrame(dotsRafRef.current);
        dotsRafRef.current = null;
      }
    };
  }, [showDots]);

  // Redraw heatmap when toggled or time window changes; refetch viewport from DB
  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready) return;
    if (heatmapEnabled) {
      fetchViewportRef.current?.();
    } else {
      s.drawHeatmap?.();
    }
  }, [heatmapEnabled]);

  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready) return;
    dbBufferRef.current = [];
    s.drawHeatmap?.();
    scheduleFetchViewport();
  }, [timeWindow]);

  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready || strikes.length === 0) return;

    import('leaflet').then(({ default: L }) => {
      for (const strike of strikes) {
        if (s.processed.has(strike.id)) break;
        s.processed.add(strike.id);

        // Add to heatmap buffer
        heatmapBufferRef.current.push({ lat: strike.lat, lon: strike.lon, time: strike.time });

        if (!strike.id.startsWith('hist-')) {
          const zoom = s.map.getZoom();
          s.rings.push({ lat: strike.lat, lon: strike.lon, startTime: performance.now(), zoomed: zoom >= 11 });

          if (soundRef.current && s.map.getBounds().contains([strike.lat, strike.lon])) {
            if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
            const now = performance.now();
            if (now - lastTickRef.current > 30) {
              lastTickRef.current = now;
              playTick(audioCtxRef.current);
            }
          }
        }

        const age = strike.id.startsWith('hist-') ? Date.now() - strike.time : 0;
        const style = getMarkerStyle(age);
        const marker = L.circleMarker([strike.lat, strike.lon], {
          ...style, renderer: s.renderer,
        }).addTo(s.layer);

        s.markers.set(strike.id, { marker, addedAt: strike.time });
      }

      // Prune heatmap buffer: keep last 7 days, cap at 100k entries
      const buf = heatmapBufferRef.current;
      const cutoff7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
      let start = 0;
      while (start < buf.length && buf[start].time < cutoff7d) start++;
      if (start > 0) heatmapBufferRef.current = buf.slice(start);
      if (heatmapBufferRef.current.length > 100_000) {
        heatmapBufferRef.current = heatmapBufferRef.current.slice(-100_000);
      }

      // Redraw heatmap to show newly arrived strikes
      s.drawHeatmap?.();
    });
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
            <button className="cell-drawer-close" onClick={() => { setSelectedCell(null); setApiData(null); setShowDots(false); }}>×</button>
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
            {(['30m', '1h', '3h', '1d', '1w'] as HeatmapWindow[]).map(w => (
              <button
                key={w}
                className={`hm-filter-btn${timeWindow === w ? ' active' : ''}`}
                onClick={() => setTimeWindow(w)}
              >
                {WINDOW_LABELS[w]}
              </button>
            ))}
          </div>
        </div>
      )}
      {heatmapEnabled && selectedCell && (
        <div className="dots-control-bar">
          <button
            className={`dots-play-btn${showDots ? ' active' : ''}`}
            onClick={() => setShowDots(d => !d)}
            title={showDots ? 'Pause replay' : 'Play strike replay (1h)'}
          >
            {showDots ? '⏸' : '▶'}
          </button>
          <input
            ref={scrubberRef}
            type="range"
            className="dots-scrubber"
            min={0}
            max={1000}
            defaultValue={0}
            onMouseDown={() => { manualScrubRef.current = 0; }}
            onTouchStart={() => { manualScrubRef.current = 0; }}
            onChange={e => {
              const v = parseInt(e.target.value, 10) / 1000;
              manualScrubRef.current = v;
              if (!showDots) setShowDots(true);
              stateRef.current.drawHeatmap?.();
            }}
            onMouseUp={e => {
              const v = parseInt((e.target as HTMLInputElement).value, 10) / 1000;
              dotsAnimStartRef.current = Date.now() - v * 20_000;
              manualScrubRef.current = null;
            }}
            onTouchEnd={e => {
              const v = parseInt((e.target as HTMLInputElement).value, 10) / 1000;
              dotsAnimStartRef.current = Date.now() - v * 20_000;
              manualScrubRef.current = null;
            }}
          />
          <span className="dots-label">1h replay</span>
        </div>
      )}
    </div>
  );
}
