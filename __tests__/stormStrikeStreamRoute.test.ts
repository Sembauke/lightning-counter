import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/storms/[key]/stream/route';
import { getStormByKey } from '../app/lib/db';
import { publishStormOwnership } from '../app/lib/strikeStream';

vi.mock('../app/lib/db', () => ({ getStormByKey: vi.fn(), resolveStormKey: (key: string) => key }));

const now = 1_000_000;
const left = { lat: 44, lon: 10, time: now - 1000 };
const right = { lat: 44, lon: 10.65, time: now - 1000 };
const source = (key: string, members = [left]) => ({ key, lat: members[0].lat, lon: members[0].lon,
  lastSeen: now, currentRate: 30, lifecycle: { members, supportMembers: members, transitions: [] } });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  for (const key of ['_stormStrikeSubscribers', '_stormStrikeOwnership', '_recentStrikes']) delete (globalThis as any)[key];
});
afterEach(() => {
  for (const key of ['_stormStrikeSubscribers', '_stormStrikeOwnership', '_recentStrikes']) delete (globalThis as any)[key];
  vi.useRealTimers(); vi.clearAllMocks();
});

async function open(key: string) {
  const response = await GET(new NextRequest(`http://localhost/api/storms/${key}/stream`), { params: Promise.resolve({ key }) });
  expect(response.status).toBe(200);
  return response.body!.getReader();
}

describe('storm-owned stream response', () => {
  it('seeds a confirmed child with only its history and unflushed live tail', async () => {
    vi.mocked(getStormByKey).mockReturnValue({ stormKey: 'left', strikes: [[44, 10, now - 1000], [44, 10.65, now - 1000]] } as any);
    publishStormOwnership([source('left'), source('right', [right])], now);
    (globalThis as any)._recentStrikes = [{ lat: 44, lon: 10.01, time: now }, { lat: 44, lon: 10.64, time: now }];
    const reader = await open('left');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(`event: history\ndata: ${JSON.stringify([[44, 10, now - 1000]])}\n\n`);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(`data: ${JSON.stringify([44, 10.01, now])}\n\n`);
    await reader.cancel();
    expect((globalThis as any)._stormStrikeSubscribers.size).toBe(0);
  });

  it('keeps both branches in pending-parent history and uses canonical alias identity', async () => {
    vi.mocked(getStormByKey).mockReturnValue({ stormKey: 'parent', strikes: null } as any);
    publishStormOwnership([source('parent', [left, right])], now);
    const reader = await open('absorbed-alias');
    const history = new TextDecoder().decode((await reader.read()).value);
    expect(history).toContain(JSON.stringify([[44, 10, now - 1000], [44, 10.65, now - 1000]]));
    expect([...(globalThis as any)._stormStrikeSubscribers.values()][0].stormKey).toBe('parent');
    await reader.cancel();
  });

  it('retains saved fading history without borrowing recent neighboring strikes', async () => {
    vi.mocked(getStormByKey).mockReturnValue({ stormKey: 'finished', strikes: [[44, 10, now - 1000]] } as any);
    (globalThis as any)._recentStrikes = [{ lat: 44, lon: 10.01, time: now }];
    const reader = await open('finished');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(`event: history\ndata: ${JSON.stringify([[44, 10, now - 1000]])}\n\n`);
    await reader.cancel();
  });
});
