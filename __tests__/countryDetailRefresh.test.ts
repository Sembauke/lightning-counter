import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchCountryDetail, type CountryDetail, type CountrySummary } from '../app/lib/countryDetailRefresh';

type Kind = 'full' | 'summary';
interface PendingRequest {
  kind: Kind;
  url: string;
  signal: AbortSignal;
  resolve: (response: Response) => void;
}

let requests: PendingRequest[];
let documentTarget: EventTarget & { visibilityState: 'visible' | 'hidden' };
let windowTarget: EventTarget;
let stop: (() => void) | undefined;

function summary(today: number): CountrySummary {
  return {
    row: { code: 'CH', today, peakCount: Math.max(500, today), peakDate: '2026-09-09' },
    history: [{ date: '2026-09-09', count: today }, { date: '2026-09-08', count: 200 }],
  };
}

function detail(today: number, count = 500): CountryDetail {
  return {
    ...summary(today),
    biggestStorm: {
      count, rate: 100, lat: 46, lon: 8, city: 'Lugano', date: '2026-09-08',
      originCity: 'Locarno', startTime: 1_788_911_800_000, endTime: 1_788_915_400_000,
      traveledKm: 50, totalCount: count, strikes: [[46, 8, 1_788_911_800_000]],
    },
  };
}

function ofKind(kind: Kind): PendingRequest[] {
  return requests.filter(request => request.kind === kind);
}

function respond(kind: Kind, index: number, value: unknown, status = 200): void {
  const request = ofKind(kind)[index];
  expect(request, `${kind} request ${index}`).toBeDefined();
  request.resolve(Response.json(value, { status }));
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 8, 9, 20));
  requests = [];
  documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' as const });
  windowTarget = new EventTarget();
  vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('window', windowTarget);
  // Browser fetch rejects a class instance as its receiver. Preserve that
  // behavior instead of masking it with an arrow-function fetch replacement.
  vi.stubGlobal('fetch', function (this: unknown, input: RequestInfo | URL, options?: RequestInit) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    const url = String(input);
    return new Promise<Response>(resolve => requests.push({
      kind: new URL(url, 'https://example.test').searchParams.get('summary') === '1' ? 'summary' : 'full',
      url, signal: options!.signal!, resolve,
    }));
  });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('country detail refresh', () => {
  it('uses the summary for initial counts when the full replay finishes first', async () => {
    const changed = vi.fn<(data: CountryDetail) => void>();
    stop = watchCountryDetail('CH', changed);
    respond('full', 0, detail(120));
    await settle();
    // The two initial snapshots may have been taken in either order.
    // Do not display the full snapshot then roll it back to an older summary.
    expect(changed).not.toHaveBeenCalled();
    respond('summary', 0, summary(100));
    await settle();
    expect(changed.mock.lastCall![0]).toEqual({ ...summary(100), biggestStorm: detail(120).biggestStorm });
    const replay = changed.mock.lastCall![0].biggestStorm;
    await vi.advanceTimersByTimeAsync(2_500);
    respond('summary', 1, summary(150));
    await settle();
    expect(changed.mock.lastCall![0]).toEqual({ ...summary(150), biggestStorm: replay });
    expect(changed.mock.lastCall![0].biggestStorm).toBe(replay);
    expect(ofKind('full')).toHaveLength(1);
  });

  it('refreshes counts while replay loads and never replaces newer counts with a late full response', async () => {
    const changed = vi.fn<(data: CountryDetail) => void>();
    stop = watchCountryDetail('CH', changed);
    expect(requests.map(request => request.url).sort()).toEqual(['/api/country/CH', '/api/country/CH?summary=1']);
    respond('summary', 0, summary(100));
    await settle();
    expect(changed).toHaveBeenLastCalledWith({ ...summary(100), biggestStorm: null });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(ofKind('full')).toHaveLength(1);
    respond('summary', 1, summary(120));
    await settle();
    respond('full', 0, detail(50));
    await settle();
    const withReplay = changed.mock.lastCall![0];
    expect(withReplay).toEqual({ ...summary(120), biggestStorm: detail(50).biggestStorm });

    await vi.advanceTimersByTimeAsync(2_500);
    respond('summary', 2, summary(150));
    await settle();
    expect(changed.mock.lastCall![0]).toEqual({ ...summary(150), biggestStorm: withReplay.biggestStorm });
    expect(changed.mock.lastCall![0].biggestStorm).toBe(withReplay.biggestStorm);
    expect(changed.mock.lastCall![0].biggestStorm!.strikes).toBe(withReplay.biggestStorm!.strikes);
    expect(ofKind('full')).toHaveLength(1);
  });

  it('retains valid counts after HTTP and malformed failures and retries the full load until it succeeds', async () => {
    const changed = vi.fn<(data: CountryDetail) => void>();
    stop = watchCountryDetail('CH', changed);
    respond('summary', 0, summary(100));
    respond('full', 0, { error: 'unavailable' }, 503);
    await settle();
    expect(changed).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_500);
    respond('summary', 1, { ...summary(900), history: null });
    respond('full', 1, { ...detail(900), biggestStorm: 'invalid replay' });
    await settle();
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.lastCall![0]).toEqual({ ...summary(100), biggestStorm: null });

    await vi.advanceTimersByTimeAsync(2_500);
    respond('summary', 2, summary(130));
    respond('full', 2, detail(80));
    await settle();
    expect(changed.mock.lastCall![0]).toEqual({ ...summary(130), biggestStorm: detail(80).biggestStorm });
    const valid = changed.mock.lastCall![0];

    await vi.advanceTimersByTimeAsync(2_500);
    respond('summary', 3, { error: 'unavailable' }, 503);
    await settle();
    expect(changed.mock.lastCall![0]).toBe(valid);
    expect(ofKind('full')).toHaveLength(3);
  });

  it('aborts on cleanup and ignores late responses even when fetch ignores the abort signal', async () => {
    const changed = vi.fn();
    stop = watchCountryDetail('CH', changed);
    const initial = [...requests];
    stop();
    expect(initial.every(request => request.signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    respond('full', 0, detail(100));
    respond('summary', 0, summary(150));
    await settle();
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    windowTarget.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changed).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses polling while hidden and refreshes immediately on resume or online without overlapping requests', async () => {
    const changed = vi.fn();
    stop = watchCountryDetail('CH', changed);
    respond('full', 0, detail(100));
    respond('summary', 0, summary(100));
    await settle();
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    windowTarget.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toHaveLength(2);

    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(ofKind('summary')).toHaveLength(2);
    windowTarget.dispatchEvent(new Event('online'));
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ofKind('summary')).toHaveLength(2);
    expect(ofKind('full')).toHaveLength(1);

    respond('summary', 1, summary(160));
    await settle();
    windowTarget.dispatchEvent(new Event('online'));
    expect(ofKind('summary')).toHaveLength(3);
  });

  it('retries timed-out requests and rejects their late responses without interfering with newer requests', async () => {
    const changed = vi.fn<(data: CountryDetail) => void>();
    stop = watchCountryDetail('CH', changed);
    const expired = [...requests];
    await vi.advanceTimersByTimeAsync(14_999);
    expect(requests).toHaveLength(2);
    expect(expired.some(request => request.signal.aborted)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ofKind('summary')[0].signal.aborted).toBe(true);
    expect(ofKind('full')[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(ofKind('full')).toHaveLength(1);
    expect(ofKind('summary')).toHaveLength(2);

    respond('summary', 0, summary(1));
    await settle();
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(ofKind('full')).toHaveLength(1);
    expect(ofKind('summary')).toHaveLength(2);

    respond('summary', 1, summary(200));
    await settle();
    expect(changed.mock.lastCall![0]).toEqual({ ...summary(200), biggestStorm: null });

    // Large replay downloads get a separate 60-second deadline. Summary
    // failures during that wait cannot remove the latest valid counts.
    await vi.advanceTimersByTimeAsync(39_999);
    expect(ofKind('full')[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ofKind('full')[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(ofKind('full')).toHaveLength(2);
    respond('full', 0, detail(1, 1));
    await settle();
    expect(changed.mock.lastCall![0]).toEqual({ ...summary(200), biggestStorm: null });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(ofKind('full')).toHaveLength(2);

    respond('full', 1, detail(100));
    await settle();
    expect(changed.mock.lastCall![0]).toEqual({ ...summary(200), biggestStorm: detail(100).biggestStorm });
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
