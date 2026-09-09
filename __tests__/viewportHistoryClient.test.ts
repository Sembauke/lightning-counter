import { describe, expect, it, vi } from 'vitest';
import {
  mapHistoryStrikeKey,
  ViewportHistoryLoader,
  type ViewportHistoryRequest,
  type ViewportHistoryStrike,
} from '../app/lib/viewportHistory';

const until = Date.UTC(2026, 8, 9, 18);
const request: ViewportHistoryRequest = {
  minLat: 35, maxLat: 60, minLon: -10, maxLon: 30,
  since: until - 60 * 60_000, until,
};

function point(id: number, time = until - 60_000): ViewportHistoryStrike {
  return { id, lat: 45 + id / 100_000_000, lon: 10, strike_time: time };
}

function page(strikes: ViewportHistoryStrike[], nextCursor: string | null = null, window = request): Response {
  return Response.json({ strikes, nextCursor, complete: nextCursor === null, since: window.since, until: window.until });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('viewport history client', () => {
  it('calls the default browser fetch with a valid receiver', async () => {
    vi.stubGlobal('fetch', function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
      if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation');
      return Promise.resolve(page([point(1)]));
    });
    try {
      const complete = vi.fn();
      const error = vi.fn();
      expect(await new ViewportHistoryLoader().load(request, { onComplete: complete, onError: error })).toBe('complete');
      expect(complete).toHaveBeenCalledWith([point(1)]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fetches all pages beyond 20,000 points without sampling or losing the hour boundary', async () => {
    const first = Array.from({ length: 20_000 }, (_, i) => point(i + 1));
    const second = Array.from({ length: 20_000 }, (_, i) => point(i + 20_001));
    const last = [point(40_001, request.since), point(40_002, request.until)];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page(first, 'cursor+one/='))
      .mockResolvedValueOnce(page(second, 'cursor-two'))
      .mockResolvedValueOnce(page(last));
    const complete = vi.fn();
    const progressive = vi.fn();

    expect(await new ViewportHistoryLoader(fetcher).load(request, {
      onPage: progressive, onComplete: complete,
    })).toBe('complete');

    expect(progressive.mock.calls.map(([points]) => points.length)).toEqual([20_000, 20_000, 2]);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0]).toEqual([...first, ...second, ...last]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const urls = fetcher.mock.calls.map(([url]) => new URL(String(url), 'https://example.test'));
    expect(urls.map(url => url.searchParams.get('cursor'))).toEqual([null, 'cursor+one/=', 'cursor-two']);
    for (const url of urls) {
      for (const [key, value] of Object.entries(request)) expect(url.searchParams.get(key)).toBe(String(value));
    }
  });

  it('deduplicates archive pages and live copies at full coordinate and time precision', async () => {
    const a = point(1);
    const sameWithAnotherRowId = { ...a, id: 2 };
    const nearby = { ...a, id: 3, lat: a.lat + 0.000_000_01 };
    const later = { ...a, id: 4, strike_time: a.strike_time + 1 };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page([a, sameWithAnotherRowId], 'next'))
      .mockResolvedValueOnce(page([sameWithAnotherRowId, nearby, later]));
    const complete = vi.fn();
    await new ViewportHistoryLoader(fetcher).load(request, { onComplete: complete });

    expect(complete.mock.calls[0][0]).toEqual([a, nearby, later]);
    const archived = complete.mock.calls[0][0] as ViewportHistoryStrike[];
    const rendered = new Set(archived.map(s => mapHistoryStrikeKey({ ...s, time: s.strike_time })));
    rendered.add(mapHistoryStrikeKey({ lat: a.lat, lon: a.lon, time: a.strike_time }));
    expect(rendered.size).toBe(3);
  });

  it('keeps the last complete buffer when a later page fails', async () => {
    const old = [point(1)];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page(old))
      .mockResolvedValueOnce(page([point(2)], 'next'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    const loader = new ViewportHistoryLoader(fetcher);
    let visible: ViewportHistoryStrike[] = [];
    const complete = vi.fn((strikes: ViewportHistoryStrike[]) => { visible = strikes; });
    const error = vi.fn();
    await loader.load(request, { onComplete: complete });
    expect(await loader.load(request, { onComplete: complete, onError: error })).toBe('failed');

    expect(visible).toEqual(old);
    expect(complete).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it.each(['fetch', 'json'] as const)('times out a hung %s without replacing the last complete buffer', async stage => {
    vi.useFakeTimers();
    try {
      const stalled = deferred<Response>();
      const stalledJson = deferred<unknown>();
      const stalledResponse = page([]);
      vi.spyOn(stalledResponse, 'json').mockReturnValue(stalledJson.promise);
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(page([point(1)]))
        .mockResolvedValueOnce(page([point(2)], 'next'))
        .mockReturnValueOnce(stage === 'fetch' ? stalled.promise : Promise.resolve(stalledResponse));
      const loader = new ViewportHistoryLoader(fetcher);
      let visible: ViewportHistoryStrike[] = [];
      const complete = vi.fn((strikes: ViewportHistoryStrike[]) => { visible = strikes; });
      const error = vi.fn();
      await loader.load(request, { onComplete: complete });
      expect(loader.loading).toBe(false);
      const pending = loader.load(request, { onComplete: complete, onError: error });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(loader.loading).toBe(true);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(loader.loading).toBe(true);
      expect(error).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toBe('failed');
      expect(loader.loading).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Viewport history request timed out' }));
      expect(visible).toEqual([point(1)]);
      expect(complete).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[2][1]!.signal!.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays loading between pages, settles on completion, and clears timeout on ignored-abort cleanup', async () => {
    vi.useFakeTimers();
    try {
      const next = deferred<Response>();
      const forever = deferred<Response>();
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(page([point(1)], 'next'))
        .mockReturnValueOnce(next.promise)
        .mockReturnValueOnce(forever.promise);
      const loader = new ViewportHistoryLoader(fetcher);
      const complete = vi.fn();
      expect(loader.loading).toBe(false);
      const loading = loader.load(request, { onComplete: complete });
      expect(loader.loading).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(loader.loading).toBe(true);
      next.resolve(page([point(2)]));
      expect(await loading).toBe('complete');
      expect(loader.loading).toBe(false);
      expect(complete).toHaveBeenCalledWith([point(1), point(2)]);
      expect(vi.getTimerCount()).toBe(0);

      const error = vi.fn();
      const cancelled = loader.load(request, { onComplete: complete, onError: error });
      expect(loader.loading).toBe(true);
      loader.cancel();
      expect(loader.loading).toBe(false);
      expect(await cancelled).toBe('cancelled');
      expect(error).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a superseded load and ignores its late response even if fetch ignores abort', async () => {
    const oldResponse = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>()
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValueOnce(page([point(2)]));
    const loader = new ViewportHistoryLoader(fetcher);
    const staleComplete = vi.fn();
    const stalePage = vi.fn();
    const staleError = vi.fn();
    const oldLoad = loader.load(request, { onPage: stalePage, onComplete: staleComplete, onError: staleError });
    const oldSignal = fetcher.mock.calls[0][1]!.signal!;
    const newComplete = vi.fn();
    expect(await loader.load({ ...request, minLat: 40 }, { onComplete: newComplete })).toBe('complete');

    expect(oldSignal.aborted).toBe(true);
    oldResponse.resolve(page([point(1)], 'old-next'));
    expect(await oldLoad).toBe('cancelled');
    expect(staleComplete).not.toHaveBeenCalled();
    expect(stalePage).not.toHaveBeenCalled();
    expect(staleError).not.toHaveBeenCalled();
    expect(newComplete).toHaveBeenCalledWith([point(2)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('also ignores a superseded response whose JSON parsing finishes late', async () => {
    const oldJson = deferred<unknown>();
    const parseStarted = deferred<void>();
    const oldResponse = page([]);
    vi.spyOn(oldResponse, 'json').mockImplementation(() => {
      parseStarted.resolve();
      return oldJson.promise;
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(oldResponse)
      .mockResolvedValueOnce(page([point(2)]));
    const loader = new ViewportHistoryLoader(fetcher);
    const staleComplete = vi.fn();
    const oldLoad = loader.load(request, { onComplete: staleComplete });
    await parseStarted.promise;
    await loader.load(request, { onComplete: vi.fn() });
    oldJson.resolve(await page([point(1)]).json());

    expect(await oldLoad).toBe('cancelled');
    expect(staleComplete).not.toHaveBeenCalled();
  });

  it('cancels the active request on cleanup without reporting a load error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const loader = new ViewportHistoryLoader(fetcher);
    const complete = vi.fn();
    const error = vi.fn();
    const pending = loader.load(request, { onComplete: complete, onError: error });
    loader.cancel();
    loader.cancel();

    expect(await pending).toBe('cancelled');
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('stops pagination if the progressive callback cancels the load', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page([point(1)], 'next'));
    const loader = new ViewportHistoryLoader(fetcher);
    const complete = vi.fn();
    expect(await loader.load(request, { onPage: () => loader.cancel(), onComplete: complete })).toBe('cancelled');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it('continues with the server-normalized first-page window', async () => {
    const normalized = { ...request, since: request.since + 1_000, until: request.until - 1_000 };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page([point(1)], 'next', normalized))
      .mockResolvedValueOnce(page([point(2)], null, normalized));
    expect(await new ViewportHistoryLoader(fetcher).load(request, { onComplete: vi.fn() })).toBe('complete');
    const next = new URL(String(fetcher.mock.calls[1][0]), 'https://example.test');
    expect(next.searchParams.get('since')).toBe(String(normalized.since));
    expect(next.searchParams.get('until')).toBe(String(normalized.until));
  });

  it.each(['window', 'cursor', 'complete'] as const)('never publishes a complete buffer after invalid %s pagination', async problem => {
    const first = page([point(1)], 'same');
    const second = problem === 'window'
      ? page([point(2)], null, { ...request, since: request.since + 1 })
      : problem === 'cursor' ? page([point(2)], 'same')
        : Response.json({ strikes: [point(2)], nextCursor: null, complete: false, since: request.since, until: request.until });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const complete = vi.fn();
    const error = vi.fn();
    expect(await new ViewportHistoryLoader(fetcher).load(request, { onComplete: complete, onError: error })).toBe('failed');
    expect(complete).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
