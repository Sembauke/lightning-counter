export const LEADERBOARD_MOVE_MS = 650;
export const LEADERBOARD_UPDATE_MS = 1_000;

interface RowPosition { top: number; opacity: string }
export interface LeaderboardSnapshot {
  rows: Map<string, RowPosition>;
  height: number;
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-leaderboard-key]'));
}

/** Capture the visible positions BEFORE React moves/removes any rows. */
export function captureLeaderboard(container: HTMLElement): LeaderboardSnapshot {
  const bounds = container.getBoundingClientRect();
  return {
    height: bounds.height,
    rows: new Map(rows(container).map(row => [row.dataset.leaderboardKey!, {
      // Relative coordinates exclude scrolling and movement elsewhere on the page.
      top: row.getBoundingClientRect().top - bounds.top,
      opacity: getComputedStyle(row).opacity,
    }])),
  };
}

export class LeaderboardMotion {
  private animations: Animation[] = [];

  cancel(): void {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
  }

  update(container: HTMLElement, previous: LeaderboardSnapshot, reducedMotion: boolean, animateHeight = true): void {
    // The snapshot includes any unfinished animation. Only now is it safe to
    // cancel it and measure the new, untransformed layout.
    this.cancel();
    if (reducedMotion || typeof container.animate !== 'function') return;
    const bounds = container.getBoundingClientRect();
    const positions = rows(container).map(row => ({
      row,
      previous: previous.rows.get(row.dataset.leaderboardKey!),
      top: row.getBoundingClientRect().top - bounds.top,
    }));
    const options: KeyframeAnimationOptions = {
      duration: LEADERBOARD_MOVE_MS,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    };
    for (const { row, previous: before, top } of positions) {
      if (!before) {
        this.animations.push(row.animate([{ opacity: 0 }, { opacity: 1 }], options));
      } else if (Math.abs(before.top - top) > 0.5 || Number(before.opacity) < 1) {
        this.animations.push(row.animate([
          { transform: `translateY(${before.top - top}px)`, opacity: before.opacity },
          { transform: 'translateY(0)', opacity: 1 },
        ], options));
      }
    }
    if (animateHeight && Math.abs(previous.height - bounds.height) > 0.5) {
      this.animations.push(container.animate([
        { height: `${previous.height}px` },
        { height: `${bounds.height}px` },
      ], options));
    }
  }
}
