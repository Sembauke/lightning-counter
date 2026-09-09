import { expect, it } from 'vitest';
import { LiveMapHistory, type MapHistoryPoint } from '../app/lib/liveMapHistory';
import { MAP_HISTORY_WINDOW_MS } from '../app/lib/mapHistory';

const now = 10_000_000;

it('retains more than fifty thousand live strikes across a full hour and prunes by time', () => {
  const history = new LiveMapHistory();
  const points = Array.from({ length: 60_001 }, (_, i) => ({ lat: 45, lon: 7, time: now - MAP_HISTORY_WINDOW_MS + i * 50 }));
  for (const point of points) history.addLive(point, now);
  expect(history.values(now)).toHaveLength(60_001);
  expect(history.values(now)).toContainEqual(points[0]);
  expect(history.values(now + 30_000)).toHaveLength(59_401);
  expect(history.values(now + MAP_HISTORY_WINDOW_MS)).toHaveLength(0);
});

it('deduplicates archive/live/reconnect overlap without rounding distinct locations together', () => {
  const history = new LiveMapHistory();
  const a = { lat: 45.00001, lon: 7, time: now - 1000 };
  const b = { ...a, lat: 45.00002 };
  history.addLive(a, now);
  history.replaceArchive([a, a, b], now);
  expect(history.values(now)).toEqual([a, b]);
  expect(history.addLive({ ...a }, now)).toBe(false);
  expect(history.addLive({ ...b }, now)).toBe(false);
  expect(history.values(now)).toEqual([a, b]);
});

it('replaces completed viewport history while retaining live points received during loading', () => {
  const history = new LiveMapHistory<MapHistoryPoint>();
  const older = { lat: 45, lon: 7, time: now - 55 * 60_000 };
  const shared = { lat: 45, lon: 7, time: now - 1000 };
  const live = { lat: 44, lon: 6, time: now };
  history.replaceArchive([older, shared], now);
  history.addLive(shared, now);
  history.addLive(live, now);
  expect(history.values(now)).toEqual([older, shared, live]);
  const elsewhere = { lat: -30, lon: 120, time: now - 45 * 60_000 };
  history.replaceArchive([elsewhere], now);
  expect(history.values(now)).toEqual([shared, live, elsewhere]);
});

it('expires out-of-order late deliveries and archive points even without more live traffic', () => {
  const history = new LiveMapHistory();
  const recent = { lat: 45, lon: 7, time: now - 1000 };
  const oldest = { lat: 45, lon: 7, time: now - MAP_HISTORY_WINDOW_MS };
  history.addLive(recent, now);
  history.addLive(oldest, now);
  history.replaceArchive([oldest], now);
  expect(history.addLive({ ...oldest, time: oldest.time - 1 }, now)).toBe(false);
  expect(history.values(now + 30_000)).toEqual([recent]);
  expect(history.values(now + MAP_HISTORY_WINDOW_MS)).toEqual([]);
});
