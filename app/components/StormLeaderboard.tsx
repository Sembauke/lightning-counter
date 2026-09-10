'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import CountryFlag from './CountryFlag';
import type { RankedNeighbor } from '../lib/db';
import { captureLeaderboard, LeaderboardMotion, LEADERBOARD_UPDATE_MS, type LeaderboardSnapshot } from '../lib/leaderboardMotion';
import styles from './StormLeaderboard.module.css';

function rankBadgeClass(rank: number): string {
  if (rank === 1) return ' storm-leaderboard-row--gold';
  if (rank === 2) return ' storm-leaderboard-row--silver';
  if (rank === 3) return ' storm-leaderboard-row--bronze';
  if (rank <= 10) return ' storm-leaderboard-row--top10';
  return '';
}

function layoutKey(rows: RankedNeighbor[]): string {
  return JSON.stringify(rows.map(row => [row.stormKey, row.rank]));
}

interface MotionProps { layout: string; children: React.ReactNode }

// A layout effect runs after React has reordered the DOM. The snapshot lifecycle
// lets us read the actual visible positions beforehand, even during an animation.
class MovingLeaderboard extends React.Component<MotionProps, Record<string, never>, LeaderboardSnapshot | null> {
  private container = React.createRef<HTMLDivElement>();
  private motion = new LeaderboardMotion();
  private preference: MediaQueryList | null = null;
  private onPreferenceChange = () => {
    if (this.preference?.matches) this.motion.cancel();
  };

  componentDidMount(): void {
    this.preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.preference.addEventListener('change', this.onPreferenceChange);
  }

  getSnapshotBeforeUpdate(previous: MotionProps): LeaderboardSnapshot | null {
    return previous.layout !== this.props.layout && this.container.current
      ? captureLeaderboard(this.container.current) : null;
  }

  componentDidUpdate(_previous: MotionProps, _state: Record<string, never>, snapshot: LeaderboardSnapshot | null): void {
    if (snapshot && this.container.current) {
      this.motion.update(this.container.current, snapshot, this.preference?.matches ?? false);
    }
  }

  componentWillUnmount(): void {
    this.motion.cancel();
    this.preference?.removeEventListener('change', this.onPreferenceChange);
  }

  render() {
    return <div ref={this.container} className={`storm-leaderboard ${styles.board}`}>{this.props.children}</div>;
  }
}

export default function StormLeaderboard({
  rows, stormKey, locale, flashKeys, countryName, label,
}: {
  rows: RankedNeighbor[];
  stormKey: string | null;
  locale: string;
  flashKeys: Set<string>;
  countryName: (code: string) => string;
  label: (row: RankedNeighbor) => string;
}) {
  const [displayed, setDisplayed] = useState(rows);
  const nextMoveAt = useRef(0);
  const targetLayout = layoutKey(rows);
  const displayedLayout = layoutKey(displayed);
  const latestByKey = useMemo(() => new Map(rows.map(row => [row.stormKey, row])), [rows]);

  useEffect(() => {
    if (targetLayout === displayedLayout) return;
    // Coalesce rapid crossings into the latest standings. The deadline stays
    // fixed as strikes arrive, so a busy storm cannot indefinitely postpone it.
    const timer = window.setTimeout(() => {
      nextMoveAt.current = performance.now() + LEADERBOARD_UPDATE_MS;
      setDisplayed(rows);
    }, Math.max(0, nextMoveAt.current - performance.now()));
    return () => window.clearTimeout(timer);
  }, [rows, targetLayout, displayedLayout]);

  return (
    <MovingLeaderboard layout={displayedLayout}>
      {displayed.map(position => {
        // Counts and names keep updating immediately, including during a move.
        const row = latestByKey.get(position.stormKey) ?? position;
        const isCurrent = row.stormKey === stormKey;
        const rowClass = `storm-leaderboard-row ${styles.row}${isCurrent
          ? ` storm-leaderboard-row--current ${styles.current}` : rankBadgeClass(position.rank)}${flashKeys.has(row.stormKey) ? ' flash' : ''}`;
        const contents = <>
          <span className="storm-leaderboard-rank">#{position.rank}</span>
          <span className="storm-leaderboard-name">
            <CountryFlag code={row.code} name={countryName(row.code)} />
            <span className="storm-leaderboard-name-text">{label(row)}</span>
          </span>
          <span className="storm-leaderboard-count">{row.totalCount.toLocaleString(locale)}</span>
        </>;
        return isCurrent
          ? <div key={row.stormKey} data-leaderboard-key={row.stormKey} className={rowClass}>{contents}</div>
          : <Link key={row.stormKey} data-leaderboard-key={row.stormKey} href={`/storms/${encodeURIComponent(row.stormKey)}`} className={rowClass}>{contents}</Link>;
      })}
    </MovingLeaderboard>
  );
}
