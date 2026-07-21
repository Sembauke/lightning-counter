'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import 'leaflet/dist/leaflet.css';
import type { Strike } from '../hooks/useBlitzortung';
import { TILE_SAT, TILE_LABELS_URL, TILE_DIM_FILTER } from '../lib/tiles';
import { detectStorms } from '../lib/stormClusters';
import { ageColor } from '../lib/ageGradient';
import { useHeatmap } from '../context/HeatmapContext';
import { useCountryTooltip } from '../context/TooltipContext';
import { useRainRadar } from '../context/RainRadarContext';
import { useStormRanks } from '../context/StormRanksContext';
import { useMapSearch } from '../context/MapSearchContext';
import { useTornado } from '../context/TornadoContext';
import { useCountryName } from '../hooks/useCountryName';

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
  dpr: number;
  drawHeatmap: (() => void) | null;
  stormRankLabels: HTMLDivElement | null;
  stormRankCells: Array<{ lat: number; lon: number; rank: number; cc: string; rate: number; trend: 'up' | 'down' | 'steady'; drift: string | null }>;
  reprojectRankLabels: (() => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  radarLayer: any;
  tornadoSvg: SVGSVGElement | null;
  tornadoFeatures: Array<{ geometry: { type: string; coordinates: number[][][][] | number[][][] }; properties: Record<string, unknown> }> | null;
  tornadoTooltip: HTMLDivElement | null;
  reprojectTornado: (() => void) | null;
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


// Everything — dot view, heatmap, viewport backfill — shows the last 30 minutes
const WINDOW_MS = 30 * 60 * 1000;

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

export default function LightningMap({ strikes, sound, historyLoaded }: { strikes: Strike[]; sound: boolean; historyLoaded: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastTickRef = useRef(0);

  const { enabled: heatmapEnabled } = useHeatmap();
  const heatmapEnabledRef = useRef(heatmapEnabled);
  heatmapEnabledRef.current = heatmapEnabled;
  const { enabled: radarEnabled } = useRainRadar();
  const { enabled: stormRanksEnabled } = useStormRanks();
  const stormRanksEnabledRef = useRef(stormRanksEnabled);
  stormRanksEnabledRef.current = stormRanksEnabled;
  const { enabled: mapSearchEnabled } = useMapSearch();
  const { enabled: tornadoEnabled } = useTornado();
  const [mapReady, setMapReady] = useState(false);
  const seenAlertIdsRef = useRef<Set<string>>(new Set());
  const [alertToasts, setAlertToasts] = useState<Array<{ id: string; event: string; area: string; key: number }>>([]);

  // Live strikes from SSE, pruned to the 30-min window
  const heatmapBufferRef = useRef<HeatPoint[]>([]);
  // DB backfill for the current viewport — covers strikes the capped SSE history missed
  const dbBufferRef = useRef<HeatPoint[]>([]);
  const viewportFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchViewportRef = useRef<(() => void) | null>(null);
  const lastDragEndRef = useRef(0);
  const isSelectingRef = useRef(false);
  const selectStartRef = useRef<{ x: number; y: number } | null>(null);
  const selectRectRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);

  // Country-under-cursor tooltip with today's strike count
  const { enabled: tooltipEnabled } = useCountryTooltip();
  const tooltipEnabledRef = useRef(tooltipEnabled);
  tooltipEnabledRef.current = tooltipEnabled;
  const [tooltip, setTooltip] = useState<{ cc: string; today: number } | null>(null);
  const tooltipPosRef = useRef({ x: 0, y: 0 });
  const tooltipDivRef = useRef<HTMLDivElement | null>(null);
  const tm = useTranslations('map');
  const countryName = useCountryName();

  // Follows the cursor without re-rendering, flipping away from the edges
  const placeTooltip = (el: HTMLDivElement, x: number, y: number) => {
    const parent = containerRef.current;
    const flipX = parent ? x > parent.offsetWidth - 190 : false;
    const flipY = parent ? y > parent.offsetHeight - 90 : false;
    el.style.left = `${x + (flipX ? -14 : 14)}px`;
    el.style.top = `${y + (flipY ? -14 : 14)}px`;
    el.style.transform = `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`;
  };
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
    const since = Date.now() - WINDOW_MS;
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
    heatCanvas: null, heatCtx: null,
    dpr: 1, drawHeatmap: null,
    stormRankLabels: null, stormRankCells: [], reprojectRankLabels: null,
    radarLayer: null,
    tornadoSvg: null, tornadoFeatures: null, tornadoTooltip: null, reprojectTornado: null,
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
        minZoom: 2, maxZoom: 16,
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
        s.reprojectRankLabels?.();
        s.reprojectTornado?.();
        scheduleFetchViewport();
      });

      map.on('move', () => { s.reprojectRankLabels?.(); s.reprojectTornado?.(); });

      map.on('dragend', () => { lastDragEndRef.current = Date.now(); });

      setZoom(map.getZoom());

      s.tileLayer = L.tileLayer(TILE_SAT.url, TILE_SAT.options).addTo(map);
      (map.getPanes().tilePane as HTMLElement).style.filter = TILE_DIM_FILTER;

      map.createPane('radarPane');
      (map.getPane('radarPane') as HTMLElement).style.zIndex = '210';
      (map.getPane('radarPane') as HTMLElement).style.pointerEvents = 'none';

      // Tornado SVG overlay — above canvas layers (z=401/450) so warnings are always visible
      const tornadoSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      tornadoSvg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:490;overflow:visible;display:none;';
      container.appendChild(tornadoSvg);
      s.tornadoSvg = tornadoSvg;

      const tornadoTooltip = document.createElement('div');
      tornadoTooltip.className = 'tornado-tooltip';
      tornadoTooltip.style.cssText = 'position:absolute;display:none;z-index:491;pointer-events:none;';
      container.appendChild(tornadoTooltip);
      s.tornadoTooltip = tornadoTooltip;

      s.reprojectTornado = () => {
        const svg = s.tornadoSvg;
        if (!svg || !s.map) return;
        // Clear existing
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const features = s.tornadoFeatures;
        if (!features?.length) { svg.style.display = 'none'; return; }
        svg.style.display = '';

        const PRIORITY: Record<string, number> = {
          'Severe Thunderstorm Watch': 0,
          'Tornado Watch': 1,
          'Severe Thunderstorm Warning': 2,
          'Flash Flood Emergency': 3,
          'Tornado Warning': 4,
        };
        const sorted = [...features].sort((a, b) =>
          (PRIORITY[(a.properties?.event as string) ?? ''] ?? 0) - (PRIORITY[(b.properties?.event as string) ?? ''] ?? 0));

        for (const f of sorted) {
          if (!f.geometry) continue;
          const evt = f.properties?.event ?? '';
          type AlertStyle = { fill: string; stroke: string; width: string; dash?: string; cls: string };
          const STYLES: Record<string, AlertStyle> = {
            'Tornado Warning':            { fill: 'rgba(255,20,20,0.30)',  stroke: '#ff0000', width: '4',   cls: 'tornado-warning-path' },
            'Tornado Watch':              { fill: 'rgba(255,220,0,0.12)',  stroke: '#ffdd00', width: '2.5', dash: '10 5', cls: 'tornado-watch-path' },
            'Severe Thunderstorm Warning':{ fill: 'rgba(255,120,0,0.25)',  stroke: '#ff7700', width: '3.5', cls: 'tornado-tstorm-warn-path' },
            'Severe Thunderstorm Watch':  { fill: 'rgba(255,180,0,0.10)',  stroke: '#ffb300', width: '2',   dash: '10 5', cls: 'tornado-tstorm-watch-path' },
            'Flash Flood Emergency':      { fill: 'rgba(180,0,255,0.25)',  stroke: '#c000ff', width: '3.5', cls: 'tornado-flood-path' },
          };
          const style: AlertStyle = STYLES[evt] ?? { fill: 'rgba(255,255,0,0.10)', stroke: '#ffff00', width: '2', dash: '8 4', cls: 'tornado-other-path' };
          const rings: number[][][] =
            f.geometry.type === 'Polygon' ? (f.geometry.coordinates as number[][][]) :
            f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as number[][][][]).flat() : [];

          for (const ring of rings) {
            const pts = ring.map(([lon, lat]) => s.map.latLngToContainerPoint([lat, lon]));
            if (pts.length < 3) continue;
            const d = pts.map((p: { x: number; y: number }, i: number) =>
              `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            path.setAttribute('fill', style.fill);
            path.setAttribute('stroke', style.stroke);
            path.setAttribute('stroke-width', style.width);
            path.setAttribute('stroke-linejoin', 'round');
            if (style.dash) path.setAttribute('stroke-dasharray', style.dash);
            path.setAttribute('class', style.cls);
            path.style.cursor = 'default';

            const tip = s.tornadoTooltip;
            if (tip) {
              const p = f.properties ?? {};
              const area = (p.areaDesc as string) ?? '';
              const exp = p.expires ? new Date(p.expires as string).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
              const certainty = (p.certainty as string) ?? '';
              const sender = (p.senderName as string) ?? '';
              const params = (p.parameters as Record<string, string[]>) ?? {};
              const motionRaw = params.eventMotionDescription?.[0] ?? '';
              const motionMatch = motionRaw.match(/(\d+)DEG\.\.\.(\d+)KT/);
              const motion = motionMatch ? `${motionMatch[1]}° · ${Math.round(parseInt(motionMatch[2]) * 1.852)} km/h` : '';
              const tornadoDetection = params.tornadoDetection?.[0] ?? '';
              const hail = params.maxHailSize?.[0] ? parseFloat(params.maxHailSize[0]) : 0;
              const windGust = params.windGust?.[0] ?? '';
              const instrFull = (p.instruction as string) ?? '';
              const instr = instrFull.split(/[.!]/)[0].trim();

              path.addEventListener('mouseenter', () => {
                const isTornadoEvent = ((p.event as string) ?? '').toLowerCase().includes('tornado');
                const certaintyBadge = isTornadoEvent && tornadoDetection
                  ? tornadoDetection === 'OBSERVED'
                    ? `<span style="color:#ff4444;font-weight:700">● TORNADO OBSERVED</span><br>`
                    : `<span style="color:#ffaa00">● ${tornadoDetection}</span><br>`
                  : '';
                const motionLine = motion ? `<span style="opacity:0.75">Moving ${motion}</span><br>` : '';
                const hailLine = hail > 0 ? `<span style="opacity:0.75">Hail up to ${hail}&quot;</span><br>` : '';
                const windLine = windGust ? `<span style="opacity:0.75">Wind gusts ${windGust}</span><br>` : '';
                const instrLine = instr ? `<span style="color:#ffcccc;font-style:italic">${instr}</span><br>` : '';
                tip.innerHTML = `<strong>${(p.event as string) ?? 'Alert'}</strong><br>`
                  + certaintyBadge
                  + `${area}<br>`
                  + motionLine + hailLine + windLine
                  + instrLine
                  + `<span style="opacity:0.6">Expires ${exp} · ${sender}</span>`;
                tip.style.display = 'block';
              });
              path.addEventListener('mousemove', (e: MouseEvent) => {
                const rect = container.getBoundingClientRect();
                tip.style.left = `${e.clientX - rect.left + 12}px`;
                tip.style.top = `${e.clientY - rect.top - 8}px`;
              });
              path.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
            }
            svg.appendChild(path);
          }
        }
      };

      map.createPane('labelsPane');
      (map.getPane('labelsPane') as HTMLElement).style.zIndex = '250';
      (map.getPane('labelsPane') as HTMLElement).style.pointerEvents = 'none';
      s.labelsLayer = L.tileLayer(TILE_LABELS_URL, { pane: 'labelsPane', maxZoom: 19, opacity: 0.75 }).addTo(map);

      // Storm rank label overlay — a plain div sibling to the canvases at z=500,
      // above the canvas overlays (z=401/450) which beat Leaflet's internal panes.
      const rankDiv = document.createElement('div');
      rankDiv.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:500;overflow:visible;';
      container.appendChild(rankDiv);
      s.stormRankLabels = rankDiv;

      s.reprojectRankLabels = () => {
        const div = s.stormRankLabels;
        if (!div || !s.map) return;
        div.innerHTML = '';
        for (const cell of s.stormRankCells) {
          const pt = s.map.latLngToContainerPoint([cell.lat, cell.lon]);
          const el = document.createElement('div');
          el.className = 'storm-rank-inner';
          el.style.cssText = `position:absolute;left:${pt.x}px;top:${pt.y}px;transform:translate(-50%,-50%);`;
          const trendIcon = cell.trend === 'up' ? '↑' : cell.trend === 'down' ? '↓' : '';
          const rateStr = cell.rate >= 1000 ? `${(cell.rate / 1000).toFixed(1)}k/m` : `${Math.round(cell.rate)}/m`;
          const driftStr = cell.drift ?? '';
          el.innerHTML = `<span class="storm-rank-num">#${cell.rank}${trendIcon ? ` <span class="storm-rank-trend" data-trend="${cell.trend}">${trendIcon}</span>` : ''}</span>`
            + (cell.cc ? `<span class="storm-rank-cc">${cell.cc}${driftStr ? ` ${driftStr}` : ''}</span>` : '')
            + `<span class="storm-rank-rate">${rateStr}</span>`;
          div.appendChild(el);
        }
      };

      s.map = map;

      const dpr = window.devicePixelRatio || 1;
      s.dpr = dpr;

      // ── Heatmap canvas — sits between the Leaflet map pane (z=400) and the ring overlay (z=450) ──
      const heatCanvas = document.createElement('canvas');
      heatCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:401;transform-origin:0 0;';
      container.appendChild(heatCanvas);
      s.heatCanvas = heatCanvas;
      s.heatCtx = heatCanvas.getContext('2d')!;

      // Baseline screen transform of the last full heat-canvas draw. While the
      // map pans/zooms we translate+scale the canvas via CSS instead of redrawing;
      // the real redraw happens on moveend.
      let heatDrawScale = 0;
      let heatDrawOx = 0;
      let heatDrawOy = 0;

      const setHeatTransform = (S1: number, o1x: number, o1y: number, animate: boolean) => {
        if (!heatDrawScale) return;
        const k = S1 / heatDrawScale;
        heatCanvas.style.transition = animate ? 'transform 0.25s cubic-bezier(0,0,0.25,1)' : 'none';
        heatCanvas.style.transform =
          `translate(${o1x - k * heatDrawOx}px, ${o1y - k * heatDrawOy}px) scale(${k})`;
      };

      // Keep the heat canvas glued to the map while dragging (translate) and
      // during animated zooms (scale, matching Leaflet's pane transition)
      map.on('move', () => {
        const S1 = 256 * Math.pow(2, map.getZoom());
        const o = map.latLngToContainerPoint([0, 0]);
        setHeatTransform(S1, o.x - S1 / 2, o.y - S1 / 2, false);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.on('zoomanim', (e: any) => {
        const S1 = 256 * Math.pow(2, e.zoom);
        setHeatTransform(
          S1,
          container.offsetWidth / 2 - mercNX(e.center.lng) * S1,
          container.offsetHeight / 2 - mercNY(e.center.lat) * S1,
          true,
        );
      });

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

        // Fresh draw in current view coordinates — drop any interim pan/zoom
        // CSS transform and record the new baseline for setHeatTransform
        heatCanvas.style.transition = 'none';
        heatCanvas.style.transform = '';
        const drawScale = 256 * Math.pow(2, s.map.getZoom());
        const drawOrg = s.map.latLngToContainerPoint([0, 0]);
        heatDrawScale = drawScale;
        heatDrawOx = drawOrg.x - drawScale * 0.5;
        heatDrawOy = drawOrg.y - drawScale * 0.5;

        hCtx.clearRect(0, 0, hCnv.width, hCnv.height);

        hCtx.save();
        hCtx.scale(dpr, dpr);

        // Dot view — always on when heatmap is inactive. Shows the last 30 minutes.
        if (!heatmapEnabledRef.current) {
          const dotCutoff = Date.now() - WINDOW_MS;
          const dotR = Math.max(2, 3 / dpr);
          // Normalize against the fixed window so colors are viewport-independent:
          // t=0 → oldest possible (cutoff), t=1 → now

          // Batch dots by color bucket — one fill() per bucket instead of per dot.
          // 20 buckets → ≤20 GPU state changes regardless of dot count.
          const N_BUCKETS = 20;
          const buckets: number[][] = Array.from({ length: N_BUCKETS }, () => []);

          // Screen transform from precomputed mercator coords: containerPoint = n * scale + offset
          const scale = drawScale;
          const ox = heatDrawOx;
          const oy = heatDrawOy;
          const cssW = hCnv.width / dpr;
          const cssH = hCnv.height / dpr;

          const binDot = (pt: HeatPoint) => {
            if (pt.time < dotCutoff) return;
            const x = pt.nx * scale + ox;
            if (x < -4 || x > cssW + 4) return;
            const y = pt.ny * scale + oy;
            if (y < -4 || y > cssH + 4) return;
            const t = Math.min(1, (pt.time - dotCutoff) / WINDOW_MS);
            const bi = Math.min(N_BUCKETS - 1, Math.floor(t * N_BUCKETS));
            buckets[bi].push(x, y);
          };
          for (let i = dbBufferRef.current.length - 1; i >= 0; i--) binDot(dbBufferRef.current[i]);
          for (const pt of heatmapBufferRef.current) binDot(pt);

          // Draw oldest buckets first so newer (brighter) paint on top
          for (let b = 0; b < N_BUCKETS; b++) {
            const flat = buckets[b];
            if (flat.length === 0) continue;
            const [r, g, bc, a] = ageColor((b + 0.5) / N_BUCKETS);
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

        const cutoff = Date.now() - WINDOW_MS;

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
      // Full 60fps only while rings animate or the map is moving. Otherwise
      // the overlay only holds slow-fading dots — 4fps is plenty.
      const ctx = overlay.getContext('2d')!;
      let lastMoveAt = 0;
      map.on('move', () => { lastMoveAt = performance.now(); });
      let lastOverlayDraw = 0;
      const drawRings = (now: number) => {
        const animating = s.rings.length > 0
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

        // Fresh-strike highlight (z=450) — only the last 2 min; older strikes are
        // shown by the gradient dot layer underneath, so this stays a small set
        if (!heatmapEnabledRef.current && s.liveDots.length > 0) {
          ctx.save();
          ctx.scale(dpr, dpr);
          const nowMs = Date.now();
          const maxAge = 2 * 60 * 1000;
          // Array is oldest-first — drop expired from the front…
          let expired = 0;
          while (expired < s.liveDots.length && nowMs - s.liveDots[expired].addedAt > maxAge) expired++;
          if (expired > 0) s.liveDots.splice(0, expired);
          // …then draw oldest→newest so the newest strikes paint on top
          for (const dot of s.liveDots) {
            const age = nowMs - dot.addedAt;
            const alpha = Math.pow(1 - age / maxAge, 0.4);
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

        s.rafId = requestAnimationFrame(drawRings);
      };
      s.rafId = requestAnimationFrame(drawRings);

      s.ready = true;
      setMapReady(true);

      // Always seed DB data on load
      fetchViewportRef.current?.();
    });

    return () => {
      const s = stateRef.current;
      if (s.heatmapTimer) clearInterval(s.heatmapTimer);
      if (s.rafId !== null) cancelAnimationFrame(s.rafId);
      if (flashRafRef.current !== null) cancelAnimationFrame(flashRafRef.current);
      s.map?.remove();
      s.map = null;
      s.ready = false;
    };
  }, []);

  // Country tooltip: stays visible while the mouse moves, updating as the
  // cursor crosses borders. Position follows every move via direct DOM writes;
  // country lookups are throttled to one per 150 ms (cache absorbs most).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    let lastLookup = 0;
    let ctrl: AbortController | null = null;
    // ~10 km grid — country lookups repeat constantly while roaming one region
    const cache = new Map<string, { cc: string | null; today: number; ts: number }>();

    const lookup = () => {
      const s = stateRef.current;
      if (!s.map || !tooltipEnabledRef.current) return;
      lastLookup = performance.now();
      const { x, y } = tooltipPosRef.current;
      const ll = s.map.containerPointToLatLng([x, y]);
      if (Math.abs(ll.lat) > 85) { setTooltip(null); return; }
      const key = `${ll.lat.toFixed(1)}:${ll.lng.toFixed(1)}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.ts < 60_000) {
        setTooltip(hit.cc ? { cc: hit.cc, today: hit.today } : null);
        return;
      }
      ctrl?.abort();
      ctrl = new AbortController();
      fetch(`/api/geo?lat=${ll.lat.toFixed(4)}&lon=${ll.lng.toFixed(4)}`, { signal: ctrl.signal })
        .then(r => r.json())
        .then((d: { cc: string | null; today: number }) => {
          cache.set(key, { ...d, ts: Date.now() });
          setTooltip(d.cc ? { cc: d.cc, today: d.today } : null);
        })
        .catch(() => {});
    };

    const onMove = (e: MouseEvent) => {
      if (!tooltipEnabledRef.current) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      tooltipPosRef.current = { x, y };
      if (tooltipDivRef.current) placeTooltip(tooltipDivRef.current, x, y);

      const since = performance.now() - lastLookup;
      if (since >= 150) {
        lookup();
      } else if (!trailing) {
        trailing = setTimeout(() => { trailing = null; lookup(); }, 150 - since);
      }
    };
    const onLeave = () => {
      if (trailing) { clearTimeout(trailing); trailing = null; }
      setTooltip(null);
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', onLeave);
      if (trailing) clearTimeout(trailing);
      ctrl?.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!tooltipEnabled) setTooltip(null);
  }, [tooltipEnabled]);

  // Fly to a location when requested elsewhere in the UI (e.g. storm panel),
  // highlighting the storm extent with a circle that fades out after 10 s
  useEffect(() => {
    let circle: { remove: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handleFlyTo = (e: Event) => {
      const { lat, lon, radiusKm } = (e as CustomEvent<{ lat: number; lon: number; radiusKm?: number }>).detail;
      const map = stateRef.current.map;
      if (!map) return;
      map.flyTo([lat, lon], Math.max(map.getZoom(), 7), { duration: 1.2 });

      import('leaflet').then(({ default: L }) => {
        if (!stateRef.current.map) return;
        circle?.remove();
        if (timer) clearTimeout(timer);
        const c = L.circle([lat, lon], {
          radius: (radiusKm ?? 30) * 1000,
          color: '#ffe040',
          weight: 2,
          dashArray: '6 6',
          fillColor: '#ffe040',
          fillOpacity: 0.05,
          interactive: false,
          className: 'storm-focus-circle',
        }).addTo(stateRef.current.map);
        circle = c;
        timer = setTimeout(() => { c.remove(); if (circle === c) circle = null; }, 10_000);
      });
    };

    window.addEventListener('lc:flyto', handleFlyTo);
    return () => {
      window.removeEventListener('lc:flyto', handleFlyTo);
      if (timer) clearTimeout(timer);
      circle?.remove();
    };
  }, []);

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

      const cutoff = Date.now() - WINDOW_MS;
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

      const cutoff = Date.now() - WINDOW_MS;
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

  // Redraw when the view mode changes — both modes share the same 30-min window
  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready) return;
    s.drawHeatmap?.();
  }, [heatmapEnabled]);

  // Rain radar overlay via RainViewer (free, no key required, ~10 min updates)
  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready) return;

    if (!radarEnabled) {
      if (s.radarLayer) { s.radarLayer.remove(); s.radarLayer = null; }
      return;
    }

    let cancelled = false;
    import('leaflet').then(async ({ default: L }) => {
      if (cancelled || !s.map) return;
      try {
        const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
        const data = await res.json() as { host: string; radar: { past: Array<{ time: number; path: string }> } };
        if (cancelled || !s.map) return;
        const latest = data.radar.past[data.radar.past.length - 1];
        if (!latest) return;
        if (s.radarLayer) { s.radarLayer.remove(); s.radarLayer = null; }
        const url = `${data.host}${latest.path}/256/{z}/{x}/{y}/4/1_1.png`;
        s.radarLayer = L.tileLayer(url, {
          opacity: 0.35,
          maxNativeZoom: 6,
          maxZoom: 16,
          pane: 'radarPane',
          attribution: 'Rain data © RainViewer',
        }).addTo(s.map);
      } catch { /* network errors are non-fatal */ }
    });

    // Refresh radar every 10 minutes
    const timer = setInterval(() => {
      if (!s.map || !s.ready) return;
      import('leaflet').then(async ({ default: L }) => {
        try {
          const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
          const data = await res.json() as { host: string; radar: { past: Array<{ time: number; path: string }> } };
          if (!s.map) return;
          const latest = data.radar.past[data.radar.past.length - 1];
          if (!latest) return;
          if (s.radarLayer) { s.radarLayer.remove(); s.radarLayer = null; }
          const url = `${data.host}${latest.path}/256/{z}/{x}/{y}/4/1_1.png`;
          s.radarLayer = L.tileLayer(url, { opacity: 0.35, maxNativeZoom: 6, maxZoom: 16, pane: 'radarPane' }).addTo(s.map);
        } catch { /* ignore */ }
      });
    }, 10 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
      if (s.radarLayer) { s.radarLayer.remove(); s.radarLayer = null; }
    };
  }, [radarEnabled, mapReady]);

  // Tornado warnings — NWS free API, US only, SVG overlay above canvas layers
  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready) return;

    const clear = () => {
      s.tornadoFeatures = null;
      if (s.tornadoSvg) { s.tornadoSvg.style.display = 'none'; while (s.tornadoSvg.firstChild) s.tornadoSvg.removeChild(s.tornadoSvg.firstChild); }
      if (s.tornadoTooltip) s.tornadoTooltip.style.display = 'none';
    };

    if (!tornadoEnabled) { clear(); seenAlertIdsRef.current.clear(); return; }

    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    let cancelled = false;
    let isFirstLoad = seenAlertIdsRef.current.size === 0;

    const load = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(
          'https://api.weather.gov/alerts/active?event=Tornado%20Warning,Tornado%20Watch,Severe%20Thunderstorm%20Warning,Severe%20Thunderstorm%20Watch,Flash%20Flood%20Emergency&status=actual',
          { headers: { Accept: 'application/geo+json' } },
        );
        const geojson = await res.json() as { features: typeof s.tornadoFeatures };
        if (cancelled) return;
        const features = (geojson.features ?? []).filter(f => f?.geometry);
        s.tornadoFeatures = features;
        s.reprojectTornado?.();

        if (isFirstLoad) {
          // Seed seen IDs silently on first load
          for (const f of features) {
            const id = (f.properties?.id as string) ?? '';
            if (id) seenAlertIdsRef.current.add(id);
          }
          isFirstLoad = false;
        } else {
          const newAlerts: Array<{ id: string; event: string; area: string }> = [];
          for (const f of features) {
            const id = (f.properties?.id as string) ?? '';
            if (id && !seenAlertIdsRef.current.has(id)) {
              seenAlertIdsRef.current.add(id);
              newAlerts.push({
                id,
                event: (f.properties?.event as string) ?? 'Alert',
                area: ((f.properties?.areaDesc as string) ?? '').split(';')[0].trim(),
              });
            }
          }
          if (newAlerts.length > 0) {
            setAlertToasts(prev => [
              ...prev,
              ...newAlerts.map(a => ({ ...a, key: Date.now() + Math.random() })),
            ]);
            // Browser notification
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              for (const a of newAlerts) {
                new Notification(`⚠ ${a.event}`, { body: a.area, tag: a.id });
              }
            }
          }
        }
      } catch { /* non-fatal */ }
    };

    load();
    const timer = setInterval(load, 3 * 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); clear(); };
  }, [tornadoEnabled, mapReady]);

  // Gate storm rank labels on the toggle
  useEffect(() => {
    const s = stateRef.current;
    if (!stormRanksEnabled) {
      s.stormRankCells = [];
      if (s.stormRankLabels) s.stormRankLabels.innerHTML = '';
    } else {
      s.reprojectRankLabels?.();
    }
  }, [stormRanksEnabled]);

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
    // 40k strikes the list can hold (useBlitzortung MAX_STRIKES), so the
    // break-at-first-seen loop stays valid
    if (s.processed.size > 50_000) {
      const it = s.processed.values();
      while (s.processed.size > 40_000) s.processed.delete(it.next().value as string);
    }

    // Prune heatmap buffer: keep the 30-min window, cap at 50k entries
    const buf = heatmapBufferRef.current;
    const pruneCutoff = Date.now() - WINDOW_MS;
    let start = 0;
    while (start < buf.length && buf[start].time < pruneCutoff) start++;
    if (start > 0) heatmapBufferRef.current = buf.slice(start);
    if (heatmapBufferRef.current.length > 50_000) {
      heatmapBufferRef.current = heatmapBufferRef.current.slice(-50_000);
    }

    // Redraw heatmap to show newly arrived strikes
    s.drawHeatmap?.();
  }, [strikes]);

  // Rank labels — detect active storm cells and render numbered badges in a plain
  // div overlay at z=500, above the canvas layers (z=401/450) that beat Leaflet panes.
  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready || !stormRanksEnabledRef.current) return;
    const STORM_WINDOW_MS = 5 * 60 * 1000;
    const cutoff = Date.now() - STORM_WINDOW_MS;
    const recent = strikes.filter(sk => sk.time > cutoff);
    const cells = detectStorms(recent, STORM_WINDOW_MS)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    s.stormRankCells = cells.map((cell, i) => {
      const ccCounts: Record<string, number> = {};
      for (const m of cell.members) if (m.cc) ccCounts[m.cc] = (ccCounts[m.cc] ?? 0) + 1;
      const cc = Object.entries(ccCounts).sort((a, b) => b[1] - a[1])[0]?.[0]?.toUpperCase() ?? '';
      return { lat: cell.lat, lon: cell.lon, rank: i + 1, cc, rate: cell.rate, trend: cell.trend, drift: cell.drift };
    });
    s.reprojectRankLabels?.();
  }, [strikes]);

  // Location search
  interface NominatimResult { place_id: number; display_name: string; lat: string; lon: string }
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<NominatimResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) { setSearchResults([]); return; }
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`, {
          headers: { 'Accept-Language': 'en' },
        });
        const data: NominatimResult[] = await res.json();
        setSearchResults(data);
        setSearchOpen(true);
      } catch { /* ignore */ }
    }, 400);
    return () => clearTimeout(id);
  }, [searchQuery]);

  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [searchOpen]);

  useEffect(() => {
    if (alertToasts.length === 0) return;
    const timer = setTimeout(() => {
      setAlertToasts(prev => prev.slice(1));
    }, 12_000);
    return () => clearTimeout(timer);
  }, [alertToasts]);

  const flyToResult = (r: NominatimResult) => {
    const map = stateRef.current.map;
    if (!map) return;
    map.flyTo([parseFloat(r.lat), parseFloat(r.lon)], 10, { duration: 1.2 });
    setSearchQuery('');
    setSearchResults([]);
    setSearchOpen(false);
  };

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
      {mapSearchEnabled && <div className="map-search" ref={searchRef}>
        <input
          className="map-search-input"
          type="text"
          placeholder="Search location…"
          value={searchQuery}
          onChange={e => { setSearchQuery(e.target.value); if (e.target.value.trim().length >= 2) setSearchOpen(true); }}
          onKeyDown={e => { if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); } }}
        />
        {searchOpen && searchResults.length > 0 && (
          <ul className="map-search-results">
            {searchResults.map(r => (
              <li key={r.place_id} className="map-search-result" onMouseDown={() => flyToResult(r)}>
                {r.display_name}
              </li>
            ))}
          </ul>
        )}
      </div>}

      {tooltip && (
        <div
          className="country-tooltip"
          ref={el => {
            tooltipDivRef.current = el;
            if (el) placeTooltip(el, tooltipPosRef.current.x, tooltipPosRef.current.y);
          }}
        >
          <span className="country-tooltip-name">{countryName(tooltip.cc)}</span>
          <span className="country-tooltip-count">{tm('strikesToday', { count: tooltip.today })}</span>
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
          <span className="heatmap-filter-label">Heatmap · last 30 min</span>
          <div className="heatmap-filter-buttons">
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
      {alertToasts.length > 0 && (
        <div className="alert-toasts">
          {alertToasts.map(toast => (
            <div key={toast.key} className={`alert-toast alert-toast--${toast.event.toLowerCase().includes('tornado') ? 'tornado' : 'tstorm'}`}>
              <span className="alert-toast-event">{toast.event}</span>
              <span className="alert-toast-area">{toast.area}</span>
              <button className="alert-toast-close" onClick={() => setAlertToasts(p => p.filter(t => t.key !== toast.key))}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
