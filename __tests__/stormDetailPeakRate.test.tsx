import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { expect, it, vi } from 'vitest';
import StormDetailClient from '../app/storms/[key]/StormDetailClient';
import { useStormMerge } from '../app/context/StormMergeContext';
import type { BiggestStorm } from '../app/lib/db';
import type { StormLiveRateSnapshot } from '../app/lib/stormLiveRate';
import en from '../messages/en.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('../app/context/StormMergeContext', () => ({ useStormMerge: vi.fn() }));

const now = Date.UTC(2026, 8, 15, 12);
const storm: BiggestStorm = {
  stormKey: 'storm', code: 'IT', city: null, lat: 45, lon: 12,
  date: '2026-09-15', count: 500, rate: 100, totalCount: 5000,
  startTime: now - 300_000, endTime: now, originLat: 45, originLon: 12,
  originCity: null, traveledKm: 0, strikes: null, countryPath: null,
};

function renderPeak(snapshot: StormLiveRateSnapshot | null, savedRate = 100): string {
  vi.mocked(useStormMerge).mockReturnValue({
    mergeMap: new Map(), now, connected: true, liveRateSnapshot: snapshot,
  });
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <StormDetailClient storm={{ ...storm, rate: savedRate }} records={[]} nearbyRanked={[]}
        initialNow={now} initialLiveStrikes={null} />
    </NextIntlClientProvider>,
  );
  return html.match(/([\d,.]+)<span class="storm-kpi-unit">\/min<\/span><\/span><span class="storm-kpi-label">Peak rate<\/span>/)?.[1] ?? '';
}

it('shows a streamed peak immediately while the polled storm metadata is still older', () => {
  expect(renderPeak({ at: now, rates: { storm: 150 }, peakRates: { storm: 150 } })).toBe('150');
});

it('keeps the peak when the current live rate falls or the feed goes stale', () => {
  expect(renderPeak({ at: now, rates: { storm: 20 }, peakRates: { storm: 150 } })).toBe('150');
  expect(renderPeak({ at: now - 10_000, rates: { storm: 20 }, peakRates: { storm: 150 } })).toBe('150');
});

it('retains the saved lifetime peak when it exceeds recent activity or the stream is unavailable', () => {
  expect(renderPeak({ at: now, rates: { storm: 20 }, peakRates: { storm: 150 } }, 200)).toBe('200');
  expect(renderPeak(null, 200)).toBe('200');
});
