import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStormStrikeOwnership, type StormOwnershipSource } from '../app/lib/stormStrikeOwnership';
import { dispatchStrike, findStormStrikeOwner, publishStormOwnership, registerStrikeSubscriber, stormStrikeHistory } from '../app/lib/strikeStream';
import type { StormStrike } from '../app/lib/db';

const now = 1_000_000;
const point = (lat: number, lon: number, time = now - 1000) => ({ lat, lon, time });
function storm(key: string, lat: number, lon: number, members = [point(lat, lon)]): StormOwnershipSource {
  return { key, lat, lon, currentRate: 30, lastSeen: now,
    lifecycle: { members, supportMembers: members, transitions: [] } };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  delete (globalThis as any)._stormStrikeSubscribers;
  delete (globalThis as any)._stormStrikeOwnership;
});
afterEach(() => {
  delete (globalThis as any)._stormStrikeSubscribers;
  delete (globalThis as any)._stormStrikeOwnership;
  vi.useRealTimers();
});

describe('per-storm live ownership', () => {
  it('separates confirmed children in both history and live dispatch even 50km apart', () => {
    const a = storm('a', 44, 10), b = storm('b', 44, 10.65);
    publishStormOwnership([a, b], now);
    const left = vi.fn(), right = vi.fn();
    registerStrikeSubscriber('left', { stormKey: 'a', send: left });
    registerStrikeSubscriber('right', { stormKey: 'b', send: right });
    dispatchStrike(44, 10.01, now);
    dispatchStrike(44, 10.64, now);
    expect(left.mock.calls).toEqual([[[44, 10.01, now]]]);
    expect(right.mock.calls).toEqual([[[44, 10.64, now]]]);
    const sharedSaved: StormStrike[] = [[44, 10, now - 1000], [44, 10.65, now - 1000]];
    expect(stormStrikeHistory('a', sharedSaved)).toEqual([sharedSaved[0]]);
    expect(stormStrikeHistory('b', sharedSaved)).toEqual([sharedSaved[1]]);
  });

  it('keeps both separated branches on their pending parent until publication confirms children', () => {
    const parent = storm('parent', 44, 10.3, [point(44, 10), point(44, 10.65)]);
    publishStormOwnership([parent], now);
    const send = vi.fn(); registerStrikeSubscriber('one', { stormKey: parent.key, send });
    dispatchStrike(44, 10.01, now); dispatchStrike(44, 10.64, now);
    expect(send).toHaveBeenCalledTimes(2);
    expect(stormStrikeHistory('parent', null)).toHaveLength(2);
    publishStormOwnership([storm('parent', 44, 10), storm('child', 44, 10.65)], now);
    dispatchStrike(44, 10.64, now + 1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('mirrors nearest-centroid assignment inside a pending merge without broadcasting to both', () => {
    const a = storm('a', 44, 10), b = storm('b', 44, 10.5);
    const transition = { id: 'merge:a:b', kind: 'merge' as const, stormKeys: ['a', 'b'],
      startedAt: now, observedAt: now, confirmAt: now + 300_000, links: [] };
    a.lifecycle!.transitions = [transition]; b.lifecycle!.transitions = [transition];
    const index = buildStormStrikeOwnership([b, a], now);
    expect(index.find(point(44, 10.22, now))).toEqual({ key: 'a', active: true });
    expect(index.find(point(44, 10.28, now))).toEqual({ key: 'b', active: true });
    expect(index.history('a')).toEqual([[44, 10, now - 1000]]);
    expect(index.history('b')).toEqual([[44, 10.5, now - 1000]]);
  });

  it('uses lexical identity ties and wraps longitude at the date line', () => {
    const index = buildStormStrikeOwnership([storm('z', 0, 0.1), storm('a', 0, -0.1)], now);
    expect(index.find(point(0, 0, now))?.key).toBe('a');
    const wrapped = buildStormStrikeOwnership([storm('date-line', 0, 179.95)], now);
    expect(wrapped.find(point(0, -179.95, now))?.key).toBe('date-line');
  });

  it('quiet owners reserve their nearby strikes without increasing any live count', () => {
    const quiet = { ...storm('quiet', 44, 10), currentRate: 19 };
    publishStormOwnership([quiet, storm('active', 44, 10.2)], now);
    const send = vi.fn();
    registerStrikeSubscriber('quiet', { stormKey: 'quiet', send });
    registerStrikeSubscriber('active', { stormKey: 'active', send });
    expect(findStormStrikeOwner(44, 10.01, now)).toEqual({ key: 'quiet', active: false });
    dispatchStrike(44, 10.01, now);
    expect(send).not.toHaveBeenCalled();
    expect(stormStrikeHistory('quiet', null)).toHaveLength(1);
  });

  it('does not grow the immutable footprint through a chain of predicted strikes', () => {
    publishStormOwnership([storm('a', 0, 0)], now);
    expect(findStormStrikeOwner(0, 0.2, now)?.key).toBe('a');
    dispatchStrike(0, 0.2, now);
    expect(findStormStrikeOwner(0, 0.4, now)).toBeUndefined();
  });

  it('member IDs override inherited replay anchors on another identity', () => {
    const a = storm('a', 44, 10), b = storm('b', 44, 10.5);
    a.replayAnchors = [[44, 10.5, now - 1000]];
    const index = buildStormStrikeOwnership([a, b], now);
    expect(index.find(point(44, 10.5))).toEqual({ key: 'b', active: true });
    expect(index.history('a')).toEqual([[44, 10, now - 1000]]);
  });

  it('forwards an existing absorbed subscriber after aliases resolve during publication', () => {
    let canonical = 'old'; const send = vi.fn();
    registerStrikeSubscriber('open-page', { stormKey: 'old', resolveKey: () => canonical, send });
    publishStormOwnership([storm('old', 44, 10)], now);
    canonical = 'survivor'; publishStormOwnership([storm('survivor', 44, 10)], now);
    dispatchStrike(44, 10.01, now);
    expect(send).toHaveBeenCalledOnce();
  });

  it('uses only saved history for untracked legacy/fading rows and never guesses new nearby lightning', () => {
    const saved: StormStrike[] = [[44, 10, now - 1000], [44, 10, now - 700_000]];
    expect(stormStrikeHistory('legacy', saved)).toEqual([saved[0]]);
    const send = vi.fn(); registerStrikeSubscriber('legacy', { stormKey: 'legacy', send });
    dispatchStrike(44, 10.01, now);
    expect(send).not.toHaveBeenCalled();
  });

  it('stops count increments when ownership evidence is stale and rejects invalid/distant data', () => {
    const index = buildStormStrikeOwnership([storm('a', 44, 10)], now);
    expect(index.find(point(44, 10, now + 90_001))).toEqual({ key: 'a', active: false });
    expect(index.find(point(44, 10, now + 600_001))).toBeUndefined();
    expect(index.find(point(Number.NaN, 10, now))).toBeUndefined();
    expect(index.find(point(44, 20, now))).toBeUndefined();
  });
});
