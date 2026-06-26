'use client';

import { useAnimatedCounter } from '../hooks/useAnimatedCounter';

interface StrikeCounterProps {
  totalCount: number;
  connected: boolean;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export default function StrikeCounter({ totalCount, connected }: StrikeCounterProps) {
  const displayed = useAnimatedCounter(totalCount, 300);
  const statusClass = connected ? 'live' : 'connecting';

  return (
    <div className={`stats-panel ${statusClass}`}>
      <span className="stats-count">{fmt(displayed)}</span>
      <span className="stats-label">TOTAL STRIKES</span>
    </div>
  );
}
