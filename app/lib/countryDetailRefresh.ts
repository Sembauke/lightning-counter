import type { StormStrike } from './db';

export interface CountrySummary {
  row: { code: string; today: number; peakCount: number; peakDate: string };
  history: Array<{ date: string; count: number }>;
}

export interface CountryDetail extends CountrySummary {
  biggestStorm: {
    count: number; rate: number; lat: number; lon: number;
    city: string | null; date: string;
    originCity: string | null; startTime: number | null; endTime: number | null;
    traveledKm: number | null; totalCount: number | null;
    strikes: StormStrike[] | null;
  } | null;
}

function isSummary(value: unknown, code: string): value is CountrySummary {
  if (!value || typeof value !== 'object') return false;
  const { row, history } = value as CountrySummary;
  return row?.code === code && Number.isFinite(row.today) && Number.isFinite(row.peakCount)
    && typeof row.peakDate === 'string' && Array.isArray(history)
    && history.every(h => h && typeof h.date === 'string' && Number.isFinite(h.count));
}

function isBiggestStorm(value: unknown): value is CountryDetail['biggestStorm'] {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const storm = value as NonNullable<CountryDetail['biggestStorm']>;
  return [storm.count, storm.rate, storm.lat, storm.lon].every(Number.isFinite)
    && [storm.startTime, storm.endTime, storm.traveledKm, storm.totalCount].every(n => n === null || Number.isFinite(n))
    && typeof storm.date === 'string'
    && [storm.city, storm.originCity].every(s => s === null || typeof s === 'string')
    && (storm.strikes === null || (Array.isArray(storm.strikes)
      && storm.strikes.every(s => Array.isArray(s) && s.length === 3 && s.every(Number.isFinite))));
}

/** Refresh counts independently of the potentially large, one-time replay load. */
export function watchCountryDetail(code: string, onChange: (data: CountryDetail) => void): () => void {
  let stopped = false;
  let fullLoaded = false;
  let summary: CountrySummary | null = null;
  let biggestStorm: CountryDetail['biggestStorm'] = null;
  const pending = new Map<'full' | 'summary', { controller: AbortController; timeout: ReturnType<typeof setTimeout> }>();

  async function request(kind: 'full' | 'summary') {
    if (stopped || pending.has(kind) || (kind === 'full' && fullLoaded)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      pending.delete(kind);
    }, kind === 'full' ? 60_000 : 15_000);
    pending.set(kind, { controller, timeout });

    try {
      const response = await fetch(`/api/country/${encodeURIComponent(code)}${kind === 'summary' ? '?summary=1' : ''}`, {
        cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) return;
      const data: unknown = await response.json();
      if (stopped || controller.signal.aborted || !isSummary(data, code)) return;

      if (kind === 'full') {
        if (!('biggestStorm' in data) || !isBiggestStorm(data.biggestStorm)) return;
        biggestStorm = data.biggestStorm;
        fullLoaded = true;
      } else {
        summary = { row: data.row, history: data.history };
      }
      // Only the serialized summary requests supply counts. Full/replay
      // responses can finish in either order without rolling those counts back.
      if (summary) onChange({ ...summary, biggestStorm });
    } catch {
      // Keep the last good data. The next tick retries a failed load.
    } finally {
      clearTimeout(timeout);
      if (pending.get(kind)?.controller === controller) pending.delete(kind);
    }
  }

  function refresh() {
    if (document.visibilityState === 'hidden') return;
    void request('summary');
    void request('full');
  }

  refresh();
  const interval = setInterval(refresh, 2_500);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('online', refresh);
  return () => {
    stopped = true;
    clearInterval(interval);
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('online', refresh);
    for (const { controller, timeout } of pending.values()) {
      clearTimeout(timeout);
      controller.abort();
    }
    pending.clear();
  };
}
