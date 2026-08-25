'use client';

import { useEffect, useRef, useState, useMemo, type ChangeEvent, type SyntheticEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useSound } from '../context/SoundContext';
import 'leaflet/dist/leaflet.css';
import type { Map as LeafletMap } from 'leaflet';
import type { StormStrike } from '../lib/db';
import { TILE_SAT, TILE_LABELS_URL, TILE_DIM_FILTER } from '../lib/tiles';
import { ageColor } from '../lib/ageGradient';
import { fmtClock } from '../lib/format';
import { computeReplayDurationMs, computeFreshMs, cutoffForProgress, progressForCutoff } from '../lib/replayTiming';

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

interface Projected { x: number; y: number; time: number }
interface Ring { x: number; y: number; start: number }

// `proj` is sorted ascending by time — binary search for the first entry
// strictly after `cutoff` so seeking can resync ring bookkeeping in O(log n)
// instead of rescanning from the start on every drag event.
function firstIndexAfter(proj: Projected[], cutoff: number): number {
  let lo = 0, hi = proj.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (proj[mid].time <= cutoff) lo = mid + 1; else hi = mid;
  }
  return lo;
}

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
  const progressInputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const projectedRef = useRef<Projected[]>([]);
  const ringsRef = useRef<Ring[]>([]);
  const rafRef = useRef<number | null>(null);
  const liveRafRef = useRef<number | null>(null);
  const appendedLengthRef = useRef(0);
  // Raw [lat, lon, time] tuples for every appended live strike, kept so
  // reprojectStrikes (called on zoom/pan) can include them alongside strikes.
  const appendedRawRef = useRef<StormStrike[]>([]);
  const maxTimeRef = useRef(-Infinity);
  // Index into projectedRef.current of the next strike that hasn't yet triggered
  // a ring burst during forward playback; resynced (without bursting) on seek.
  const nextIdxRef = useRef(0);
  const startRef = useRef(0);
  // Whether playback was running when the user grabbed the scrubber, so
  // releasing it resumes instead of leaving the replay paused.
  const wasPlayingRef = useRef(false);
  const { sound } = useSound();
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastTickRef = useRef(0);
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

  // Playback timing, derived once per strike set so the scrubber can seek
  // before the user ever presses play, not just while play() is running.
  const replayMeta = useMemo(() => {
    const times = strikes.map(s => s[2]).sort((a, b) => a - b);
    // Skip isolated early strikes: find the first index where the gap to the
    // NEXT strike is less than 2 hours — the storm is "continuous" from there.
    // This prevents a single outlier strike 11 hours before the main activity
    // from padding the replay with empty screen.
    let replayMinTime = times[0] ?? minTime;
    const GAP_MS = 2 * 60 * 60 * 1000;
    for (let i = 0; i < times.length - 1; i++) {
      if (times[i + 1] - times[i] < GAP_MS) { replayMinTime = times[i]; break; }
    }
    const spanMs = Math.max(1, maxTime - replayMinTime);
    const replayMs = computeReplayDurationMs(spanMs);
    const freshMs = computeFreshMs(spanMs, replayMs);
    // Sample rings evenly across the storm instead of ringing every strike
    const ringEvery = Math.max(1, Math.round(times.length / TARGET_RING_COUNT));
    return { replayMinTime, spanMs, replayMs, freshMs, ringEvery };
  }, [strikes, minTime, maxTime]);

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
      let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      for (const s of strikes) {
        if (s[0] < minLat) minLat = s[0];
        if (s[0] > maxLat) maxLat = s[0];
        if (s[1] < minLon) minLon = s[1];
        if (s[1] > maxLon) maxLon = s[1];
      }
      const bounds = L.latLngBounds([minLat, minLon], [maxLat, maxLon]);
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
        const all = appendedRawRef.current.length
          ? [...strikes, ...appendedRawRef.current]
          : strikes;
        projectedRef.current = all
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

    // Always store raw coords — reprojectStrikes() uses appendedRawRef so these
    // will be included even if the map isn't ready yet (Leaflet loads async).
    for (const s of newBatch) {
      appendedRawRef.current.push(s);
      if (s[2] > maxTimeRef.current) maxTimeRef.current = s[2];
    }

    const map = mapRef.current;
    if (!map) return; // reprojectStrikes() will project them on map init

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

    if (soundRef.current && newBatch.length > 0) {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
      const toPlay = Math.min(newBatch.length, 12);
      for (let i = 0; i < toPlay; i++) {
        setTimeout(() => {
          const t = performance.now();
          if (t - lastTickRef.current > 30) {
            lastTickRef.current = t;
            playTick(audioCtxRef.current!);
          }
        }, Math.random() * 700);
      }
    }
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

  // Draws the frame at `cutoff` and updates the time label + scrubber position.
  // `spawnRings` is true only during forward auto-playback ticks — a manual
  // seek just shows the state at that moment, it doesn't replay ring bursts
  // for every strike jumped over.
  const renderAt = (cutoff: number, now: number, spawnRings: boolean) => {
    const proj = projectedRef.current;
    const { replayMinTime, freshMs, ringEvery } = replayMeta;
    if (spawnRings) {
      while (nextIdxRef.current < proj.length && proj[nextIdxRef.current].time <= cutoff) {
        const idx = nextIdxRef.current;
        if (idx % ringEvery === 0 && ringsRef.current.length < MAX_RINGS_REPLAY) {
          ringsRef.current.push({ x: proj[idx].x, y: proj[idx].y, start: now + Math.random() * 150 });
        }
        nextIdxRef.current++;
      }
    } else {
      nextIdxRef.current = firstIndexAfter(proj, cutoff);
    }
    draw(cutoff, now, freshMs, cutoff - GRADIENT_REF_MS);
    if (timeTextRef.current) timeTextRef.current.textContent = fmtClock(cutoff, true);
    if (progressInputRef.current) {
      progressInputRef.current.value = String(progressForCutoff(cutoff, replayMinTime, maxTime));
    }
  };

  const startPlaybackFrom = (progress: number) => {
    const proj = projectedRef.current;
    if (proj.length === 0) return;
    const { replayMinTime, replayMs } = replayMeta;
    ringsRef.current = [];
    const p0 = Math.min(1, Math.max(0, progress));
    startRef.current = performance.now() - p0 * replayMs;
    nextIdxRef.current = firstIndexAfter(proj, cutoffForProgress(p0, replayMinTime, maxTime));
    setPlaying(true);

    const tick = (now: number) => {
      const p = Math.min(1, (now - startRef.current) / replayMs);
      const cutoff = cutoffForProgress(p, replayMinTime, maxTime);
      renderAt(cutoff, now, true);

      const strikesRemaining = nextIdxRef.current < projectedRef.current.length;
      if (p < 1 || strikesRemaining || ringsRef.current.length > 0) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
        draw(maxTime, performance.now());
        if (timeTextRef.current) timeTextRef.current.textContent = timeRange;
        if (progressInputRef.current) progressInputRef.current.value = '1';
        setPlaying(false);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const play = () => {
    if (playing) return;
    const current = progressInputRef.current ? Number(progressInputRef.current.value) : 0;
    startPlaybackFrom(current >= 1 ? 0 : current);
  };

  // Scrubbing: grabbing the handle pauses auto-playback (remembering whether
  // it was running); dragging redraws the map live; releasing resumes
  // playback from the dropped position if it had been running.
  const scrubStart = () => {
    wasPlayingRef.current = playing;
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  };
  const scrubInput = (e: ChangeEvent<HTMLInputElement>) => {
    const { replayMinTime } = replayMeta;
    const cutoff = cutoffForProgress(Number(e.target.value), replayMinTime, maxTime);
    renderAt(cutoff, performance.now(), false);
  };
  const scrubEnd = (e: SyntheticEvent<HTMLInputElement>) => {
    if (wasPlayingRef.current) startPlaybackFrom(Number((e.target as HTMLInputElement).value));
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
        : (
          <div className="bsc-replay-controls">
            <button className="bsc-replay-btn" onClick={play} disabled={playing}>▶ {t('replay')}</button>
            <input
              ref={progressInputRef}
              className="bsc-replay-scrub"
              type="range"
              min={0}
              max={1}
              step={0.0005}
              defaultValue={0}
              aria-label={t('replay')}
              onPointerDown={scrubStart}
              onKeyDown={scrubStart}
              onChange={scrubInput}
              onPointerUp={scrubEnd}
              onKeyUp={scrubEnd}
            />
          </div>
        )
      }
    </div>
  );
}
