'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import CountryFlag from './CountryFlag';
import type { RankedNeighbor } from '../lib/db';
import { useStormLeaderboard, type LoadLeaderboardPage } from '../hooks/useStormLeaderboard';
import { captureLeaderboard, LeaderboardMotion, LEADERBOARD_UPDATE_MS, LEADERBOARD_MOVE_MS, type LeaderboardSnapshot } from '../lib/leaderboardMotion';
import styles from './StormLeaderboard.module.css';

function rankBadgeClass(rank: number): string {
  if (rank === 1) return ' storm-leaderboard-row--gold';
  if (rank === 2) return ' storm-leaderboard-row--silver';
  if (rank === 3) return ' storm-leaderboard-row--bronze';
  if (rank <= 10) return ' storm-leaderboard-row--top10';
  return '';
}

function layoutKey(rows: Array<RankedNeighbor & { rankKnown: boolean }>): string {
  return JSON.stringify(rows.map(row => [row.stormKey, row.rank, row.rankKnown]));
}

interface MotionProps {
  layout: string;
  children: React.ReactNode;
  following: boolean;
  moreAbove: boolean;
  pause: () => void;
  loadMore: () => void;
  protectedKeys: React.RefObject<Set<string>>;
}

// Keep row motion inside a scrolling viewport. Taking this snapshot before the
// DOM changes also lets a prepend preserve the exact position being viewed.
class MovingLeaderboard extends React.Component<MotionProps, Record<string, never>, LeaderboardSnapshot | null> {
  private container = React.createRef<HTMLDivElement>();
  private viewport = React.createRef<HTMLDivElement>();
  private motion = new LeaderboardMotion();
  private preference: MediaQueryList | null = null;
  private frame: number | null = null;
  private resize: ResizeObserver | null = null;

  private cancelFollow = () => {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  };

  private centerCurrent = () => {
    const viewport = this.viewport.current;
    const current = this.container.current?.querySelector<HTMLElement>('.storm-leaderboard-row--current');
    if (!viewport || !current) return;
    const currentBounds = current.getBoundingClientRect();
    const relativeTop = currentBounds.top - viewport.getBoundingClientRect().top - viewport.clientTop;
    viewport.scrollTop += relativeTop - (viewport.clientHeight - currentBounds.height) / 2;
  };

  private follow = () => {
    this.cancelFollow();
    if (!this.props.following) return;
    // Read the row's animated position on each frame, so scrolling follows the
    // same easing as its slide rather than fighting a second scroll animation.
    this.centerCurrent();
    if (this.preference?.matches) return;
    const until = performance.now() + LEADERBOARD_MOVE_MS;
    const tick = () => {
      this.centerCurrent();
      this.protectVisible();
      if (performance.now() < until) this.frame = requestAnimationFrame(tick);
      else this.frame = null;
    };
    this.frame = requestAnimationFrame(tick);
  };

  private protectVisible = () => {
    const viewport = this.viewport.current;
    if (!viewport || !this.container.current) return;
    const bounds = viewport.getBoundingClientRect();
    const focused = document.activeElement?.closest<HTMLElement>('[data-leaderboard-key]');
    const keys = new Set<string>();
    this.container.current.querySelectorAll<HTMLElement>('[data-leaderboard-key]').forEach(row => {
      const rect = row.getBoundingClientRect();
      if ((rect.bottom > bounds.top && rect.top < bounds.bottom) || row === focused) {
        keys.add(row.dataset.leaderboardKey!);
      }
    });
    this.props.protectedKeys.current = keys;
  };

  private onScroll = () => {
    this.protectVisible();
    if (!this.props.following && (this.viewport.current?.scrollTop ?? Infinity) < 160) this.props.loadMore();
  };

  private pause = () => {
    this.cancelFollow();
    const viewport = this.viewport.current;
    if (viewport) viewport.scrollTo({ top: viewport.scrollTop, behavior: 'instant' });
    this.props.pause();
  };

  private onPreferenceChange = () => {
    if (this.preference?.matches) {
      this.motion.cancel();
      this.cancelFollow();
      if (this.props.following) this.centerCurrent();
    }
  };

  componentDidMount(): void {
    this.preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.preference.addEventListener('change', this.onPreferenceChange);
    if (this.props.following) this.centerCurrent();
    this.protectVisible();
    this.resize = new ResizeObserver(() => {
      if (this.props.following) this.centerCurrent();
      this.protectVisible();
    });
    if (this.viewport.current) this.resize.observe(this.viewport.current);
  }

  getSnapshotBeforeUpdate(previous: MotionProps): LeaderboardSnapshot | null {
    return (previous.layout !== this.props.layout || previous.moreAbove !== this.props.moreAbove) && this.container.current
      ? captureLeaderboard(this.container.current) : null;
  }

  componentDidUpdate(previous: MotionProps, _state: Record<string, never>, snapshot: LeaderboardSnapshot | null): void {
    const container = this.container.current;
    const viewport = this.viewport.current;
    if (snapshot && container && viewport) {
      this.motion.cancel();
      const elements = [...container.querySelectorAll<HTMLElement>('[data-leaderboard-key]')];
      const beforeKeys = [...snapshot.rows.keys()];
      const afterKeys = elements.map(row => row.dataset.leaderboardKey!);
      const oldKeys = new Set(beforeKeys), newKeys = new Set(afterKeys);
      const addedAbove = Math.max(0, afterKeys.findIndex(key => oldKeys.has(key)));
      const removedAbove = Math.max(0, beforeKeys.findIndex(key => newKeys.has(key)));
      const beforeScroll = viewport.scrollTop;
      viewport.scrollTop += (addedAbove - removedAbove) * (elements[0]?.getBoundingClientRect().height ?? 0);
      const offset = viewport.scrollTop - beforeScroll;
      for (const position of snapshot.rows.values()) position.top += offset;
      this.motion.update(container, snapshot, this.preference?.matches ?? false, false);
      this.follow();
      this.protectVisible();
    } else if (previous.following !== this.props.following) {
      this.cancelFollow();
      const current = container?.querySelector<HTMLElement>('.storm-leaderboard-row--current');
      if (this.props.following && viewport && current) {
        viewport.scrollTo({
          top: viewport.scrollTop + current.getBoundingClientRect().top - viewport.getBoundingClientRect().top
            - viewport.clientTop - (viewport.clientHeight - current.getBoundingClientRect().height) / 2,
          behavior: this.preference?.matches ? 'instant' : 'smooth',
        });
      } else if (viewport && viewport.scrollTop < 160) {
        this.props.loadMore();
      }
    }
  }

  componentWillUnmount(): void {
    this.motion.cancel();
    this.cancelFollow();
    this.resize?.disconnect();
    this.preference?.removeEventListener('change', this.onPreferenceChange);
  }

  render() {
    return <div ref={this.viewport} className={styles.viewport} onScroll={this.onScroll}
      onWheel={this.pause} onTouchStart={this.pause} onPointerDown={this.pause}
      onFocusCapture={() => { this.pause(); this.protectVisible(); }}
      onKeyDown={event => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) this.pause();
      }} tabIndex={0} role="region" aria-label="Storm leaderboard">
      <div ref={this.container} className={`storm-leaderboard ${styles.board}${this.props.moreAbove ? ` ${styles.moreAbove}` : ''}`}>{this.props.children}</div>
    </div>;
  }
}

export default function StormLeaderboard({
  rows: initialRows, stormKey, locale, flashKeys, countryName, label, totalCount, loadPage,
}: {
  rows: RankedNeighbor[];
  totalCount?: number;
  loadPage?: LoadLeaderboardPage;
  stormKey: string | null;
  locale: string;
  flashKeys: Set<string>;
  countryName: (code: string) => string;
  label: (row: RankedNeighbor) => React.ReactNode;
}) {
  const protectedKeys = useRef(new Set<string>());
  const [following, setFollowing] = useState(true);
  const fetchPage = useCallback<LoadLeaderboardPage>(async (before, signal) => {
    const url = `/api/storms/${encodeURIComponent(stormKey ?? '')}/leaderboard`;
    let response = await fetch(before ? `${url}?${new URLSearchParams({ before })}` : url, { signal });
    let reset = response.status === 404 && !!before;
    if (reset) response = await fetch(url, { signal });
    if (!response.ok) throw new Error('Unable to load rankings');
    let page = await response.json();
    if (before && !reset && Array.isArray(page.rows) && page.rows.length === 0) {
      response = await fetch(url, { signal });
      if (!response.ok) throw new Error('Unable to refresh rankings');
      page = await response.json();
      reset = true;
    }
    return { ...page, reset };
  }, [stormKey]);
  const board = useStormLeaderboard(initialRows, stormKey, totalCount, loadPage ?? fetchPage, protectedKeys);
  const rows = board.rows;
  const [displayed, setDisplayed] = useState(rows);
  const [displayedRankKnown, setDisplayedRankKnown] = useState(board.rankKnown);
  const [displayedMoreAbove, setDisplayedMoreAbove] = useState(board.moreAbove);
  const nextMoveAt = useRef(0);
  const targetLayout = layoutKey(rows);
  const displayedLayout = layoutKey(displayed);
  const latestByKey = useMemo(() => new Map(rows.map(row => [row.stormKey, row])), [rows]);

  useEffect(() => {
    if (targetLayout === displayedLayout && displayedRankKnown === board.rankKnown && displayedMoreAbove === board.moreAbove) return;
    // Coalesce rapid crossings into the latest standings. The deadline stays
    // fixed as strikes arrive, so a busy storm cannot indefinitely postpone it.
    const displayedKeys = new Set(displayed.map(row => row.stormKey));
    const hasIncomingRows = rows.some(row => !displayedKeys.has(row.stormKey));
    const timer = window.setTimeout(() => {
      nextMoveAt.current = performance.now() + LEADERBOARD_UPDATE_MS;
      setDisplayed(rows);
      setDisplayedRankKnown(board.rankKnown);
      setDisplayedMoreAbove(board.moreAbove);
    }, hasIncomingRows ? 0 : Math.max(0, nextMoveAt.current - performance.now()));
    return () => window.clearTimeout(timer);
  }, [rows, displayed, targetLayout, displayedLayout, board.rankKnown, displayedRankKnown, board.moreAbove, displayedMoreAbove]);

  return (
    <>
    <div className={styles.controls}>
      {following ? <span>Following storm</span> : <button onClick={() => setFollowing(true)}>Follow storm</button>}
      {board.error ? <span>Rankings unavailable. <button onClick={board.retry}>Retry</button></span>
        : board.loading ? <span role="status">Loading rankings…</span> : null}
    </div>
    <MovingLeaderboard layout={displayedLayout} following={following} pause={() => setFollowing(false)}
      moreAbove={displayedMoreAbove || !displayedRankKnown}
      loadMore={board.loadMore} protectedKeys={protectedKeys}>
      {displayed.map(position => {
        // Counts and names keep updating immediately, including during a move.
        const row = latestByKey.get(position.stormKey) ?? position;
        const isCurrent = row.stormKey === stormKey;
        const rankKnown = row.rankKnown && position.rankKnown;
        const rowClass = `storm-leaderboard-row ${styles.row}${isCurrent
          ? ` storm-leaderboard-row--current ${styles.current}` : rankKnown ? rankBadgeClass(position.rank) : ''}${flashKeys.has(row.stormKey) ? ' flash' : ''}`;
        const contents = <>
          <span className="storm-leaderboard-rank">{rankKnown ? `#${position.rank}` : '…'}</span>
          <span className="storm-leaderboard-name">
            <CountryFlag code={row.code} name={countryName(row.code)} />
            <span className="storm-leaderboard-name-text">{label(row)}</span>
          </span>
          <span className="storm-leaderboard-count">{row.totalCount.toLocaleString(locale)}</span>
        </>;
        return isCurrent
          ? <div key={row.stormKey} data-leaderboard-key={row.stormKey} className={rowClass}>{contents}</div>
          : <Link key={row.stormKey} data-leaderboard-key={row.stormKey} href={`/storms/${encodeURIComponent(row.stormKey)}`} prefetch={false} className={rowClass}>{contents}</Link>;
      })}
    </MovingLeaderboard>
    </>
  );
}
