'use client';

import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import type { Strike } from '../hooks/useBlitzortung';

interface MarkerEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  marker: any;
  addedAt: number;
}

interface MapState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  map: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderer: any;
  markers: Map<string, MarkerEntry>;
  processed: Set<string>;
  styleInterval: ReturnType<typeof setInterval> | null;
  ready: boolean;
}

// Color bands match the ColorLegend component
function getMarkerStyle(ageMs: number) {
  if (ageMs < 10_000)   return { radius: 4, fillColor: '#ffffff', color: '#ffffff', fillOpacity: 1,    opacity: 0, weight: 0 };
  if (ageMs < 60_000)   return { radius: 3, fillColor: '#ffff00', color: '#ffff00', fillOpacity: 0.95, opacity: 0, weight: 0 };
  if (ageMs < 300_000)  return { radius: 3, fillColor: '#ffcc00', color: '#ffcc00', fillOpacity: 0.8,  opacity: 0, weight: 0 };
  if (ageMs < 900_000)  return { radius: 2, fillColor: '#ff8800', color: '#ff8800', fillOpacity: 0.65, opacity: 0, weight: 0 };
  // 15–30 min: fade out to invisible
  const fadeT = Math.min((ageMs - 900_000) / 900_000, 1);
  return { radius: 2, fillColor: '#ff4400', color: '#ff4400', fillOpacity: 0.45 * (1 - fadeT), opacity: 0, weight: 0 };
}

function animateFlash(L: any, layer: any, svgRenderer: any, lat: number, lon: number) {
  const ring = L.circleMarker([lat, lon], {
    radius: 3,
    color: '#ffffff',
    weight: 2,
    fillOpacity: 0,
    opacity: 0.9,
    renderer: svgRenderer,
  }).addTo(layer);

  let frame = 0;
  const totalFrames = 18;

  const tick = () => {
    frame++;
    const p = frame / totalFrames;
    if (p >= 1) { layer.removeLayer(ring); return; }
    ring.setRadius(3 + p * 18);
    ring.setStyle({ opacity: (1 - p) * 0.85 });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export default function LightningMap({ strikes }: { strikes: Strike[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<MapState>({
    map: null, layer: null, renderer: null,
    markers: new Map(), processed: new Set(),
    styleInterval: null, ready: false,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svgRendererRef = useRef<any>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const s = stateRef.current;

    import('leaflet').then(({ default: L }) => {
      if (s.map || !container) return;

      const worldBounds = L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180));

      const map = L.map(container, {
        center: [20, 0],
        zoom: 2,
        minZoom: 2,
        maxZoom: 12,
        zoomControl: true,
        attributionControl: false,
        maxBounds: worldBounds,
        maxBoundsViscosity: 1.0,
      });

      // Position zoom control bottom-right (away from our panels)
      map.zoomControl.setPosition('bottomright');

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 19,
      }).addTo(map);

      s.renderer = L.canvas({ padding: 0.5 });
      svgRendererRef.current = L.svg({ padding: 0.5 });
      s.layer = L.layerGroup().addTo(map);
      s.map = map;
      s.ready = true;

      s.styleInterval = setInterval(() => {
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
      }, 2000);
    });

    return () => {
      if (s.styleInterval) clearInterval(s.styleInterval);
      s.map?.remove();
      s.map = null;
      s.ready = false;
    };
  }, []);

  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready || strikes.length === 0) return;

    import('leaflet').then(({ default: L }) => {
      for (const strike of strikes) {
        if (s.processed.has(strike.id)) break;
        s.processed.add(strike.id);

        // Only flash strikes that are genuinely new (not pre-loaded history)
        const isLive = !strike.id.startsWith('hist-');
        if (isLive) {
          animateFlash(L, s.layer, svgRendererRef.current, strike.lat, strike.lon);
        }

        const style = getMarkerStyle(0);
        const marker = L.circleMarker([strike.lat, strike.lon], {
          ...style,
          renderer: s.renderer,
        }).addTo(s.layer);

        s.markers.set(strike.id, { marker, addedAt: strike.time });
      }
    });
  }, [strikes]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', background: '#0a0a0f' }}
    />
  );
}
