import type { MapHistoryBounds, MapHistoryPage, MapHistoryStrike } from './mapHistory';

const PAGE_TIMEOUT_MS = 30_000;

export type ViewportHistoryStrike = MapHistoryStrike;

export interface ViewportHistoryRequest extends MapHistoryBounds {
  since: number;
  until: number;
}

export interface ViewportHistoryCallbacks {
  /** Optional progressive additions; keep the previous viewport until onComplete. */
  onPage?: (strikes: ViewportHistoryStrike[]) => void;
  onComplete: (strikes: ViewportHistoryStrike[]) => void;
  onError?: (error: unknown) => void;
}

/** Match archive and live points without merging nearby strikes through rounding. */
export function mapHistoryStrikeKey(point: { lat: number; lon: number; time: number }): string {
  return `${point.time}:${point.lat}:${point.lon}`;
}

function parsePage(value: unknown): MapHistoryPage {
  const page = value as Partial<MapHistoryPage> | null;
  if (!page || !Array.isArray(page.strikes) || typeof page.complete !== 'boolean'
    || !Number.isFinite(page.since) || !Number.isFinite(page.until)
    || page.since! > page.until!
    || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))
    || page.complete !== (page.nextCursor === null)
    || page.strikes.some(point => !point || !Number.isFinite(point.id)
      || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) || !Number.isFinite(point.strike_time))) {
    throw new Error('Invalid viewport history page');
  }
  return page as MapHistoryPage;
}

/**
 * Load every page of one fixed viewport/time snapshot. Only a fully fetched,
 * current generation can replace the caller's last complete viewport buffer.
 */
export class ViewportHistoryLoader {
  private generation = 0;
  private controller: AbortController | null = null;

  // Native browser fetch rejects this loader as its receiver. Keep the default
  // call on the global function; injected test transports still use this slot.
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  get loading(): boolean {
    return this.controller !== null;
  }

  cancel(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }

  private async fetchPage(url: string, controller: AbortController): Promise<unknown> {
    let timeout: ReturnType<typeof setTimeout>;
    let onAbort: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        clearTimeout(timeout);
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => {
        controller.abort(new Error('Viewport history request timed out'));
      }, PAGE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        interrupted,
        (async () => {
          const response = await this.fetcher(url, { signal: controller.signal, cache: 'no-store' });
          if (controller.signal.aborted) throw controller.signal.reason;
          if (!response.ok) throw new Error(`Viewport history request failed (${response.status})`);
          return response.json();
        })(),
      ]);
    } finally {
      clearTimeout(timeout!);
      controller.signal.removeEventListener('abort', onAbort!);
    }
  }

  async load(
    request: ViewportHistoryRequest,
    callbacks: ViewportHistoryCallbacks,
  ): Promise<'complete' | 'cancelled' | 'failed'> {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const isCurrent = () => this.generation === generation && !controller.signal.aborted;
    const params = new URLSearchParams(Object.entries(request).map(([key, value]) => [key, String(value)]));
    const strikes: ViewportHistoryStrike[] = [];
    const seenPoints = new Set<string>();
    const seenCursors = new Set<string>();
    let window: { since: number; until: number } | null = null;

    try {
      while (isCurrent()) {
        const data = await this.fetchPage(`/api/grid/viewport?${params}`, controller);
        if (!isCurrent()) return 'cancelled';
        const page = parsePage(data);
        if (window && (page.since !== window.since || page.until !== window.until)) {
          throw new Error('Viewport history window changed while loading');
        }
        if (page.nextCursor && seenCursors.has(page.nextCursor)) {
          throw new Error('Viewport history cursor did not advance');
        }
        window = { since: page.since, until: page.until };
        const additions: ViewportHistoryStrike[] = [];
        for (const point of page.strikes) {
          const key = mapHistoryStrikeKey({ lat: point.lat, lon: point.lon, time: point.strike_time });
          if (seenPoints.has(key)) continue;
          seenPoints.add(key);
          strikes.push(point);
          additions.push(point);
        }
        if (additions.length) callbacks.onPage?.(additions);
        // A progressive callback can itself navigate away or start another load.
        if (!isCurrent()) return 'cancelled';
        if (page.complete) {
          callbacks.onComplete(strikes);
          return 'complete';
        }
        seenCursors.add(page.nextCursor!);
        params.set('since', String(window.since));
        params.set('until', String(window.until));
        params.set('cursor', page.nextCursor!);
      }
      return 'cancelled';
    } catch (error) {
      // A timeout aborts the current request and reports failure. Only explicit
      // cancellation/supersession advances the generation and stays silent.
      if (this.generation !== generation) return 'cancelled';
      callbacks.onError?.(error);
      return 'failed';
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
