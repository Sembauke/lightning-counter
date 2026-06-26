'use client';

import { useBlitzortung } from '../hooks/useBlitzortung';
import { useMemo } from 'react';

function toFlag(code: string): string {
  if (code.length !== 2) return '🌐';
  return [...code.toUpperCase()]
    .map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65))
    .join('');
}

const displayNames = typeof Intl !== 'undefined'
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

function countryName(code: string): string {
  try { return displayNames?.of(code) ?? code; } catch { return code; }
}

export default function CountriesPage() {
  const { countryCounts, totalCount, connected } = useBlitzortung();

  const ranked = useMemo(() => {
    return Object.entries(countryCounts)
      .map(([code, count]) => ({ code, count, name: countryName(code), flag: toFlag(code) }))
      .sort((a, b) => b.count - a.count);
  }, [countryCounts]);

  const topCount = ranked[0]?.count ?? 1;
  const statusClass = connected ? 'live' : 'connecting';
  const statusLabel = connected ? '● LIVE' : '○ CONNECTING…';

  return (
    <div className="countries-page">
      <div className="countries-subheader">
        <span className={`stats-status ${statusClass}`}>{statusLabel}</span>
        <span className="countries-total">{totalCount.toLocaleString('en-US')} total strikes</span>
      </div>

      <div className="countries-grid">
        {ranked.length === 0 ? (
          <div className="countries-empty">Waiting for strike data…</div>
        ) : (
          ranked.map(({ code, count, name, flag }, i) => (
            <div className="country-card" key={code}>
              <span className="card-rank">#{i + 1}</span>
              <span className="card-flag">{flag}</span>
              <span className="card-name">{name}</span>
              <span className="card-count">{count.toLocaleString('en-US')}</span>
              <span className="card-label">strikes</span>
              <div className="card-bar-wrap">
                <div
                  className="card-bar"
                  style={{ width: `${(count / topCount) * 100}%` }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
