'use client';

import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import type { Strike } from '../hooks/useBlitzortung';

interface FlashRing {
  lat: number;
  lon: number;
  startTime: number;
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
  rings: FlashRing[];
  rafId: number | null;
  ready: boolean;
}

function getMarkerStyle(ageMs: number) {
  if (ageMs < 10_000)  return { radius: 4, fillColor: '#ffe040', color: '#ff2222', fillOpacity: 1,    opacity: 0.9, weight: 1.5 };
  if (ageMs < 60_000)  return { radius: 3, fillColor: '#ffff00', color: '#ffff00', fillOpacity: 0.95, opacity: 0,   weight: 0 };
  if (ageMs < 300_000) return { radius: 3, fillColor: '#ffcc00', color: '#ffcc00', fillOpacity: 0.8,  opacity: 0,   weight: 0 };
  if (ageMs < 900_000) return { radius: 2, fillColor: '#ff8800', color: '#ff8800', fillOpacity: 0.65, opacity: 0,   weight: 0 };
  const fadeT = Math.min((ageMs - 900_000) / 900_000, 1);
  return { radius: 2, fillColor: '#ff4400', color: '#ff4400', fillOpacity: 0.45 * (1 - fadeT), opacity: 0, weight: 0 };
}

const TILE_DARK = {
  url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  options: { subdomains: 'abcd', maxZoom: 19 },
};
const TILE_SAT = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  options: { maxZoom: 19 },
};
// ESRI reference: country borders + place names, no roads
const TILE_LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

function playTick(ctx: AudioContext) {
  const duration = 0.018;
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    // White noise with sharp exponential decay = Geiger-counter click
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

export default function LightningMap({ strikes, satellite, sound }: { strikes: Strike[]; satellite: boolean; sound: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const satelliteRef = useRef(satellite);
  satelliteRef.current = satellite;
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastTickRef = useRef(0);

  const stateRef = useRef<MapState>({
    map: null, layer: null, renderer: null, tileLayer: null, labelsLayer: null,
    markers: new Map(), processed: new Set(),
    styleInterval: null, rings: [], rafId: null, ready: false,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const s = stateRef.current;

    import('leaflet').then(({ default: L }) => {
      if (s.map || !container) return;

      const worldBounds = L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180));
      const map = L.map(container, {
        center: [20, 0], zoom: 2, minZoom: 2, maxZoom: 12,
        zoomControl: true, attributionControl: false,
        maxBounds: worldBounds, maxBoundsViscosity: 1.0,
      });
      map.zoomControl.setPosition('bottomright');

      const initTile = satelliteRef.current ? TILE_SAT : TILE_DARK;
      s.tileLayer = L.tileLayer(initTile.url, initTile.options).addTo(map);

      if (satelliteRef.current) {
        (map.getPanes().tilePane as HTMLElement).style.filter = 'brightness(0.55)';
      }

      // Labels pane sits above the (possibly darkened) tile pane but below strike markers
      map.createPane('labelsPane');
      (map.getPane('labelsPane') as HTMLElement).style.zIndex = '250';
      (map.getPane('labelsPane') as HTMLElement).style.pointerEvents = 'none';
      s.labelsLayer = L.tileLayer(TILE_LABELS_URL, { pane: 'labelsPane', maxZoom: 19, opacity: 0.4 });
      if (satelliteRef.current) s.labelsLayer.addTo(map);

      s.renderer = L.canvas({ padding: 0.5 });
      s.layer = L.layerGroup().addTo(map);
      s.map = map;

      // Dedicated overlay canvas — one RAF loop draws ALL rings; no Leaflet layer overhead
      const dpr = window.devicePixelRatio || 1;
      const overlay = document.createElement('canvas');
      overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:450;';
      container.appendChild(overlay);

      const sizeOverlay = () => {
        overlay.width  = container.offsetWidth  * dpr;
        overlay.height = container.offsetHeight * dpr;
      };
      sizeOverlay();
      const ro = new ResizeObserver(sizeOverlay);
      ro.observe(container);

      const ctx = overlay.getContext('2d')!;

      // Thunder travels 343 m/s; audible up to ~25 km (73 s real time).
      // Ring expands linearly (constant wave speed), compressed to 3 s visual.
      // At low zoom the geographic 25 km is sub-pixel, so we use a minimum that
      // matches what 25 km looks like at zoom 9 (~160 px) to always feel significant.
      // 25 km / 343 m·s⁻¹ = 72.9 s — ring lives exactly as long as thunder is audible
      const DURATION = 73_000;
      const MIN_PX = 160;

      const drawRings = (now: number) => {
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        const zoom = map.getZoom();
        if (s.rings.length > 0 && zoom >= 11) {
          const metersPerPx = 156_543 / Math.pow(2, zoom);
          const maxPx = Math.max(MIN_PX, Math.min(600, Math.round(25_000 / metersPerPx)));

          ctx.save();
          ctx.scale(dpr, dpr);

          let i = s.rings.length;
          while (i--) {
            const ring = s.rings[i];
            const p = Math.min((now - ring.startTime) / DURATION, 1);
            if (p >= 1) { s.rings.splice(i, 1); continue; }

            const radius  = maxPx * p;
            const opacity = Math.pow(1 - p, 2) * 0.85;
            const lw      = 0.5 + (1 - p) * 2.5;

            const pt = map.latLngToContainerPoint([ring.lat, ring.lon]);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, Math.max(1, radius), 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(255,255,255,${opacity.toFixed(3)})`;
            ctx.lineWidth = lw;
            ctx.stroke();
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
    });

    return () => {
      const s = stateRef.current;
      if (s.styleInterval) clearInterval(s.styleInterval);
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
    if (satellite) {
      s.labelsLayer.addTo(s.map);
    } else {
      s.labelsLayer.remove();
    }
  }, [satellite]);

  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready || strikes.length === 0) return;

    import('leaflet').then(({ default: L }) => {
      for (const strike of strikes) {
        if (s.processed.has(strike.id)) break;
        s.processed.add(strike.id);

        if (!strike.id.startsWith('hist-')) {
          s.rings.push({ lat: strike.lat, lon: strike.lon, startTime: performance.now() });

          if (soundRef.current && s.map.getBounds().contains([strike.lat, strike.lon])) {
            if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
            const now = performance.now();
            if (now - lastTickRef.current > 30) { // max ~33 ticks/sec
              lastTickRef.current = now;
              playTick(audioCtxRef.current);
            }
          }
        }

        const style = getMarkerStyle(0);
        const marker = L.circleMarker([strike.lat, strike.lon], {
          ...style, renderer: s.renderer,
        }).addTo(s.layer);

        s.markers.set(strike.id, { marker, addedAt: strike.time });
      }
    });
  }, [strikes]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', background: '#0a0a0f' }} />
  );
}
