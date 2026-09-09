import type { MapHistoryBounds } from './mapHistory';
import type { GridArchivePage } from './gridArchiveTypes';

interface Callbacks {
  onComplete: (page: GridArchivePage) => void;
  onError: () => void;
}

/** Keep backward navigation on the same snapshot instead of rebuilding OFFSET queries. */
export class GridArchivePager {
  private bounds: MapHistoryBounds | null = null;
  private pages = new Map<number, GridArchivePage>();
  private controller: AbortController | null = null;
  private generation = 0;

  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}

  cancel(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }

  open(bounds: MapHistoryBounds, callbacks: Callbacks): Promise<void> {
    this.pages.clear();
    this.bounds = { ...bounds };
    return this.goTo(1, callbacks);
  }

  async goTo(number: number, callbacks: Callbacks): Promise<void> {
    this.cancel();
    if (!this.bounds) return;
    const cached = this.pages.get(number);
    if (cached) { callbacks.onComplete(cached); return; }
    const previous = this.pages.get(number - 1);
    if (number !== 1 && !previous?.nextCursor) { callbacks.onError(); return; }
    const generation = this.generation;
    const controller = this.controller = new AbortController();
    const params = previous?.nextCursor ? new URLSearchParams({ cursor: previous.nextCursor })
      : new URLSearchParams(Object.entries(this.bounds).map(([key, value]) => [key, String(value)]));
    const timeout = setTimeout(() => controller.abort(new Error('Archive request timed out')), 15_000);
    let abort: () => void = () => {};
    try {
      const data = await Promise.race([
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
        }),
        (async () => {
          const response = await this.fetcher(`/api/grid/area?${params}`, { signal: controller.signal, cache: 'no-store' });
          if (!response.ok) throw new Error('Archive request failed');
          return response.json() as Promise<GridArchivePage>;
        })(),
      ]);
      if (generation !== this.generation || controller.signal.aborted) return;
      if (!Array.isArray(data.strikes) || data.page !== number || !Number.isSafeInteger(data.total)
        || !Number.isSafeInteger(data.pages) || (data.nextCursor !== null && typeof data.nextCursor !== 'string')) {
        throw new Error('Invalid archive page');
      }
      this.pages.set(number, data);
      callbacks.onComplete(data);
    } catch {
      if (generation === this.generation) callbacks.onError();
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abort);
      if (this.controller === controller) this.controller = null;
    }
  }
}
