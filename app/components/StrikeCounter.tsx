'use client';

import CountUp from 'react-countup';

interface Props {
  totalCount: number;
  connected: boolean;
}

export default function StrikeCounter({ totalCount, connected }: Props) {
  return (
    <div className="strike-badge">
      <span className={`strike-badge-dot${connected ? ' live' : ''}`} />
      <span className="strike-badge-count">
        <CountUp preserveValue end={totalCount} separator="," />
      </span>
      <span className="strike-badge-label">strikes</span>
    </div>
  );
}
