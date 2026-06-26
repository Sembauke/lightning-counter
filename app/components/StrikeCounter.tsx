'use client';

import { useAnimatedCounter, useStrikeRate } from '../hooks/useAnimatedCounter';

interface StrikeCounterProps {
  totalCount: number;
  connected: boolean;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export default function StrikeCounter({ totalCount, connected }: StrikeCounterProps) {
  const displayed = useAnimatedCounter(totalCount, 300);
  const rate = useStrikeRate(totalCount);

  const statusClass = connected ? 'live' : 'connecting';
  const statusLabel = connected ? '● LIVE' : '○ CONNECTING…';

  return (
    <div className="stats-panel">
      <span className={`stats-status ${statusClass}`}>{statusLabel}</span>
      <span className="stats-sep" />
      <span className="stats-count">{fmt(displayed)}</span>
      <span className="stats-label">TOTAL STRIKES</span>
      <span className="stats-sep" />
      <span className="stats-rate">
        <span className="rate-val">{fmt(rate)}</span>
        <span className="rate-unit">/min</span>
      </span>
    </div>
  );
}
