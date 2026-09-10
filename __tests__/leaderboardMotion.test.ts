import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureLeaderboard, LeaderboardMotion, LEADERBOARD_MOVE_MS } from '../app/lib/leaderboardMotion';

interface RunningAnimation {
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  progress: number;
  cancelled: boolean;
  cancel: ReturnType<typeof vi.fn>;
}

// The fake layout retains running animation effects until cancel(), just as
// getBoundingClientRect/getComputedStyle do in the browser. This makes measuring
// before versus after cancellation observable rather than returning fixed rects.
function boardFixture(entries: Array<[string, number]>, height = entries.length * 40) {
  let viewportTop = 800;
  let naturalHeight = height;
  const allAnimations: RunningAnimation[] = [];
  const rowStates = new Map<string, {
    element: HTMLElement;
    top: number;
    animations: RunningAnimation[];
  }>();
  let order = entries.map(([key]) => key);
  const containerAnimations: RunningAnimation[] = [];

  function startAnimation(list: RunningAnimation[], frames: Keyframe[], options: KeyframeAnimationOptions): Animation {
    const animation: RunningAnimation = {
      frames, options, progress: 0, cancelled: false,
      cancel: vi.fn(() => { animation.cancelled = true; }),
    };
    list.push(animation);
    allAnimations.push(animation);
    return animation as unknown as Animation;
  }

  function active(list: RunningAnimation[]): RunningAnimation | undefined {
    return [...list].reverse().find(animation => !animation.cancelled);
  }

  function value(animation: RunningAnimation | undefined, property: 'height' | 'opacity' | 'transform', fallback: number): number {
    if (!animation) return fallback;
    const numeric = (frame: Keyframe) => {
      const raw = frame[property];
      if (raw == null) return fallback;
      return property === 'transform'
        ? Number(String(raw).match(/translateY\(([-\d.]+)(?:px)?\)/)?.[1] ?? 0)
        : parseFloat(String(raw));
    };
    const from = numeric(animation.frames[0]);
    const to = numeric(animation.frames[animation.frames.length - 1]);
    return from + (to - from) * animation.progress;
  }

  function addRow(key: string, top: number) {
    const state = { element: null as unknown as HTMLElement, top, animations: [] as RunningAnimation[] };
    state.element = {
      dataset: { leaderboardKey: key },
      getBoundingClientRect: () => ({ top: viewportTop + state.top + value(active(state.animations), 'transform', 0), height: 40 }),
      animate: (frames: Keyframe[], options: KeyframeAnimationOptions) => startAnimation(state.animations, frames, options),
    } as unknown as HTMLElement;
    rowStates.set(key, state);
  }
  for (const [key, top] of entries) addRow(key, top);

  const container = {
    querySelectorAll: () => order.map(key => rowStates.get(key)!.element),
    getBoundingClientRect: () => ({ top: viewportTop, height: value(active(containerAnimations), 'height', naturalHeight) }),
    animate: (frames: Keyframe[], options: KeyframeAnimationOptions) => startAnimation(containerAnimations, frames, options),
  } as unknown as HTMLElement;

  vi.stubGlobal('getComputedStyle', (element: HTMLElement) => {
    const state = [...rowStates.values()].find(row => row.element === element)!;
    return { opacity: String(value(active(state.animations), 'opacity', 1)) };
  });

  return {
    container, allAnimations, containerAnimations,
    row: (key: string) => rowStates.get(key)!,
    scrollTo: (top: number) => { viewportTop = top; },
    layout: (nextEntries: Array<[string, number]>, nextHeight = nextEntries.length * 40) => {
      for (const [key, top] of nextEntries) {
        if (!rowStates.has(key)) addRow(key, top);
        rowStates.get(key)!.top = top;
      }
      order = nextEntries.map(([key]) => key);
      naturalHeight = nextHeight;
    },
    advance: (progress: number) => {
      for (const animation of allAnimations) if (!animation.cancelled) animation.progress = progress;
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('leaderboard motion', () => {
  it('captures relative visual positions and ignores scrolling between rank updates', () => {
    const board = boardFixture([['a', 0], ['b', 40], ['c', 80]]);
    const beforeScroll = captureLeaderboard(board.container);
    board.scrollTo(-240);
    expect(captureLeaderboard(board.container)).toEqual(beforeScroll);

    board.layout([['b', 0], ['c', 40], ['a', 80]]);
    const motion = new LeaderboardMotion();
    motion.update(board.container, beforeScroll, false);
    expect(board.row('a').animations[0].frames[0].transform).toBe('translateY(-80px)');
    expect(board.row('b').animations[0].frames[0].transform).toBe('translateY(40px)');
    expect(board.row('c').animations[0].frames[0].transform).toBe('translateY(40px)');
    expect(captureLeaderboard(board.container)).toEqual(beforeScroll);
    board.advance(1);
    expect(captureLeaderboard(board.container).rows.get('a')!.top).toBe(80);
  });

  it('retargets a rapid second crossing from the actual in-flight positions', () => {
    const board = boardFixture([['a', 0], ['b', 40], ['c', 80]]);
    const motion = new LeaderboardMotion();
    const first = captureLeaderboard(board.container);
    board.layout([['b', 0], ['c', 40], ['a', 80]]);
    motion.update(board.container, first, false);
    board.advance(0.5);
    const visible = captureLeaderboard(board.container);
    expect(visible.rows.get('a')!.top).toBe(40);
    const previousAnimations = [...board.allAnimations];

    // React takes the snapshot above, reorders the nodes, then invokes update.
    board.layout([['a', 0], ['b', 40], ['c', 80]]);
    motion.update(board.container, visible, false);
    expect(previousAnimations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(board.row('a').animations[1].frames[0].transform).toBe('translateY(40px)');
    expect(board.row('b').animations[1].frames[0].transform).toBe('translateY(-20px)');
    expect(captureLeaderboard(board.container)).toEqual(visible);
    board.advance(1);
    expect(captureLeaderboard(board.container).rows.get('a')!.top).toBe(0);
  });

  it('fades new neighbors and preserves a partly visible entrant on the next update', () => {
    const board = boardFixture([['a', 0], ['b', 40]]);
    const motion = new LeaderboardMotion();
    const first = captureLeaderboard(board.container);
    board.layout([['new', 0], ['a', 40]]);
    motion.update(board.container, first, false);
    expect(board.row('new').animations[0].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(board.row('b').animations).toHaveLength(0);
    board.advance(0.35);
    const partial = captureLeaderboard(board.container);
    expect(partial.rows.get('new')!.opacity).toBe('0.35');

    board.layout([['a', 0], ['new', 40]]);
    motion.update(board.container, partial, false);
    expect(board.row('new').animations[1].frames[0]).toEqual({ transform: 'translateY(-40px)', opacity: '0.35' });
    expect(captureLeaderboard(board.container)).toEqual(partial);
    expect(board.allAnimations.every(animation => animation.options.duration === LEADERBOARD_MOVE_MS)).toBe(true);
  });

  it('resumes an interrupted height change from its visible height when the neighbor window changes size', () => {
    const board = boardFixture([['a', 0], ['b', 40], ['c', 80], ['d', 120]]);
    const motion = new LeaderboardMotion();
    const first = captureLeaderboard(board.container);
    board.layout([['a', 0], ['b', 40], ['c', 80]]);
    motion.update(board.container, first, false);
    expect(board.containerAnimations[0].frames).toEqual([{ height: '160px' }, { height: '120px' }]);
    board.advance(0.5);
    const partial = captureLeaderboard(board.container);
    expect(partial.height).toBe(140);

    board.layout([['a', 0], ['b', 40], ['c', 80], ['d', 120], ['e', 160]]);
    motion.update(board.container, partial, false);
    expect(board.containerAnimations[0].cancel).toHaveBeenCalledOnce();
    expect(board.containerAnimations[1].frames).toEqual([{ height: '140px' }, { height: '200px' }]);
    expect(captureLeaderboard(board.container).height).toBe(140);
    board.advance(1);
    expect(captureLeaderboard(board.container).height).toBe(200);
  });

  it('cancels running effects when reduced motion is enabled and does not start new ones', () => {
    const board = boardFixture([['a', 0], ['b', 40]]);
    const motion = new LeaderboardMotion();
    const first = captureLeaderboard(board.container);
    board.layout([['b', 0], ['a', 40]]);
    motion.update(board.container, first, false);
    board.advance(0.2);
    const partial = captureLeaderboard(board.container);
    const started = board.allAnimations.length;
    board.layout([['a', 0], ['b', 40], ['new', 80]]);
    motion.update(board.container, partial, true);
    expect(board.allAnimations).toHaveLength(started);
    expect(board.allAnimations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(captureLeaderboard(board.container).rows.get('a')).toEqual({ top: 0, opacity: '1' });
    expect(captureLeaderboard(board.container).height).toBe(120);
  });

  it('cleans up all retained and removed row effects exactly once', () => {
    const board = boardFixture([['a', 0], ['b', 40]]);
    const motion = new LeaderboardMotion();
    const first = captureLeaderboard(board.container);
    board.layout([['b', 0], ['a', 40], ['new', 80]]);
    motion.update(board.container, first, false);
    expect(board.allAnimations).toHaveLength(4);
    board.layout([['a', 0]]);
    motion.cancel();
    motion.cancel();
    expect(board.allAnimations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(captureLeaderboard(board.container)).toEqual({ height: 40, rows: new Map([['a', { top: 0, opacity: '1' }]]) });
  });

  it('leaves unchanged rows still when only counts or rank labels change', () => {
    const board = boardFixture([['a', 0], ['b', 40]]);
    const motion = new LeaderboardMotion();
    motion.update(board.container, captureLeaderboard(board.container), false);
    expect(board.allAnimations).toHaveLength(0);
  });

  it('falls back to the updated layout when Web Animations is unavailable', () => {
    const board = boardFixture([['a', 0], ['b', 40]]);
    const before = captureLeaderboard(board.container);
    board.layout([['b', 0], ['a', 40]]);
    Object.defineProperty(board.container, 'animate', { value: undefined });
    new LeaderboardMotion().update(board.container, before, false);
    expect(board.allAnimations).toHaveLength(0);
    expect(captureLeaderboard(board.container).rows.get('a')!.top).toBe(40);
  });
});
