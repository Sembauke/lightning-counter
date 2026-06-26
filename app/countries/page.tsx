'use client';

import { useBlitzortung } from '../hooks/useBlitzortung';
import { useMemo } from 'react';

function toFlag(code: string): string {
  if (code.length !== 2) return '';
  return [...code.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
}

const displayNames = typeof Intl !== 'undefined' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
function countryName(code: string): string {
  try { return displayNames?.of(code) ?? code; } catch { return code; }
}

function fmt(n: number) { return n.toLocaleString('en-US'); }

export default function CountriesPage() {
  const { countryCounts, totalCount } = useBlitzortung();

  const ranked = useMemo(() => {
    return Object.entries(countryCounts)
      .map(([code, count]) => ({ code, count, name: countryName(code), flag: toFlag(code) }))
      .sort((a, b) => b.count - a.count);
  }, [countryCounts]);

  const topCount = ranked[0]?.count ?? 1;

  return (
    <div className="country-list-page">
      <div className="country-list-header">
        <span className="country-list-title">Strikes per Country</span>
        <span className="country-list-meta">{fmt(totalCount)} total · {ranked.length} countries</span>
      </div>

      <div className="country-list-body">
        {ranked.length === 0 ? (
          <div className="country-list-empty">Waiting for data…</div>
        ) : (
          <table className="country-list-table">
            <thead>
              <tr>
                <th className="cl-rank">#</th>
                <th>Country</th>
                <th className="cl-num">Strikes</th>
                <th className="cl-bar-col"></th>
                <th className="cl-pct">Share</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map(({ code, count, name, flag }, i) => (
                <tr key={code} className="cl-row">
                  <td className="cl-rank">{i + 1}</td>
                  <td className="cl-country">
                    <span className="cl-flag">{flag}</span>
                    <span className="cl-name">{name}</span>
                  </td>
                  <td className="cl-num">{fmt(count)}</td>
                  <td className="cl-bar-col">
                    <div className="cl-bar-wrap">
                      <div className="cl-bar" style={{ width: `${(count / topCount) * 100}%` }} />
                    </div>
                  </td>
                  <td className="cl-pct">{((count / totalCount) * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
