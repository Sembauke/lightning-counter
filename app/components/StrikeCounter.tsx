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

  return (
    <div className="strike-badge">
      <span className={`strike-badge-dot${connected ? ' live' : ''}`} />
      <span className="strike-badge-count">{fmt(displayed)}</span>
      <span className="strike-badge-label">strikes</span>
    </div>
  );
}
