import { MAP_HISTORY_WINDOW_MS } from './mapHistory';
import { mapHistoryStrikeKey } from './viewportHistory';

export interface MapHistoryPoint { lat: number; lon: number; time: number }

/** One physical strike per dot/bin, regardless of live, reconnect or DB delivery. */
export class LiveMapHistory<T extends MapHistoryPoint> {
  private points = new Map<string, T>();
  private live = new Set<string>();
  private archived = new Set<string>();
  private cached: T[] | null = null;
  private lastPruned = -Infinity;

  addLive(point: T, now = Date.now()): boolean {
    if (!this.inWindow(point, now)) return false;
    const key = mapHistoryStrikeKey(point);
    this.live.add(key);
    if (this.points.has(key)) return false;
    this.points.set(key, point);
    this.cached = null;
    return true;
  }

  /** Call only after every page of the new viewport has loaded successfully. */
  replaceArchive(points: T[], now = Date.now()): void {
    const next = new Set<string>();
    for (const point of points) {
      if (!this.inWindow(point, now)) continue;
      const key = mapHistoryStrikeKey(point);
      next.add(key);
      if (!this.points.has(key)) this.points.set(key, point);
    }
    for (const key of this.archived) {
      if (!next.has(key) && !this.live.has(key)) this.points.delete(key);
    }
    this.archived = next;
    this.cached = null;
    this.prune(now);
  }

  values(now = Date.now()): T[] {
    // Renderers still apply the exact cutoff; this bounds memory without
    // rebuilding the full collection on every animation frame.
    if (now - this.lastPruned >= 30_000) this.prune(now);
    return this.cached ??= [...this.points.values()];
  }

  private inWindow(point: T, now: number): boolean {
    return Number.isFinite(point.lat) && Number.isFinite(point.lon) && Number.isFinite(point.time)
      && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180
      && point.time >= now - MAP_HISTORY_WINDOW_MS && point.time <= now + 60_000;
  }

  private prune(now: number): void {
    for (const [key, point] of this.points) {
      if (point.time >= now - MAP_HISTORY_WINDOW_MS) continue;
      this.points.delete(key);
      this.live.delete(key);
      this.archived.delete(key);
      this.cached = null;
    }
    this.lastPruned = now;
  }
}
