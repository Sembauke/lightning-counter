'use client';

import { buildCounterItems } from '../lib/formatCounter';

interface Props {
  totalCount: number;
  connected: boolean;
}

function RollingDigit({ digit }: { digit: string }) {
  const d = parseInt(digit, 10);
  return (
    <span className="counter-digit-outer">
      <span
        className="counter-digit-inner"
        style={{ transform: `translateY(-${d * 10}%)` }}
      >
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="counter-digit-num">{i}</span>
        ))}
      </span>
    </span>
  );
}

export default function StrikeCounter({ totalCount, connected }: Props) {
  const items = buildCounterItems(totalCount);

  return (
    <div className="strike-badge">
      <span className={`strike-badge-dot${connected ? ' live' : ''}`} />
      <span className="counter-roller" aria-label={`${totalCount} strikes`}>
        {items.map(item =>
          item.type === 'comma'
            ? <span key={item.key} className="counter-sep">,</span>
            : <RollingDigit key={item.key} digit={item.digit!} />
        )}
      </span>
      <span className="strike-badge-label">strikes</span>
    </div>
  );
}
