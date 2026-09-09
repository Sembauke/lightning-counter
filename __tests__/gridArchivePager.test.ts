import { describe, expect, it, vi } from 'vitest';
import { GridArchivePager } from '../app/lib/gridArchivePager';
import type { GridArchivePage } from '../app/lib/gridArchiveTypes';

const bounds = { minLat: 44, maxLat: 46, minLon: 6, maxLon: 8 };
function page(number: number, cursor: string | null): GridArchivePage {
  return { strikes: [{ id: number, lat: 45, lon: 7, strike_time: 100 }], total: 51, page: number,
    pages: 3, limit: 25, since: 0, until: 100, nextCursor: cursor };
}

describe('archive drawer cursor pagination', () => {
  it('uses a valid receiver for the native browser fetch default', async () => {
    vi.stubGlobal('fetch', function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(Response.json(page(1, null)));
    });
    try {
      const onComplete = vi.fn(), onError = vi.fn();
      await new GridArchivePager().open(bounds, { onComplete, onError });
      expect(onComplete).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('uses server cursors for forward pages and cached original snapshots for backward pages', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page(1, 'cursor+one=')))
      .mockResolvedValueOnce(Response.json(page(2, 'cursor-two')));
    const pager = new GridArchivePager(fetcher);
    const onComplete = vi.fn(), onError = vi.fn();
    await pager.open(bounds, { onComplete, onError });
    const first = onComplete.mock.lastCall![0];
    await pager.goTo(2, { onComplete, onError });
    expect(new URL(String(fetcher.mock.calls[1][0]), 'https://example.test').searchParams.get('cursor')).toBe('cursor+one=');
    expect(String(fetcher.mock.calls[1][0])).not.toContain('page=');
    await pager.goTo(1, { onComplete, onError });
    expect(onComplete.mock.lastCall![0]).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores a slow previous selection even if its fetch ignores abort', async () => {
    let oldResolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>()
      .mockReturnValueOnce(new Promise(resolve => { oldResolve = resolve; }))
      .mockResolvedValueOnce(Response.json(page(1, null)));
    const pager = new GridArchivePager(fetcher);
    const stale = vi.fn(), current = vi.fn(), onError = vi.fn();
    const pending = pager.open(bounds, { onComplete: stale, onError });
    await pager.open({ ...bounds, minLat: 45 }, { onComplete: current, onError });
    oldResolve(Response.json(page(1, 'old')));
    await pending;
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('preserves the current page on failure and allows a fresh retry after an expired cursor', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page(1, 'expired')))
      .mockResolvedValueOnce(new Response('', { status: 400 }))
      .mockResolvedValueOnce(Response.json(page(1, 'fresh')));
    const pager = new GridArchivePager(fetcher);
    const onComplete = vi.fn(), onError = vi.fn();
    await pager.open(bounds, { onComplete, onError });
    await pager.goTo(2, { onComplete, onError });
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    await pager.open(bounds, { onComplete, onError });
    expect(onComplete.mock.lastCall![0].nextCursor).toBe('fresh');
  });

  it('times out hung requests and cancels all pending callbacks on drawer cleanup', async () => {
    vi.useFakeTimers();
    try {
      const pager = new GridArchivePager(() => new Promise(() => {}));
      const onComplete = vi.fn(), onError = vi.fn();
      const pending = pager.open(bounds, { onComplete, onError });
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
      expect(onError).toHaveBeenCalledOnce();
      const cancelled = pager.open(bounds, { onComplete, onError });
      pager.cancel();
      await cancelled;
      expect(vi.getTimerCount()).toBe(0);
      expect(onComplete).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
