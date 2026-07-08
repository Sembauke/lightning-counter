'use client';

import { useBlitzortung } from '../hooks/useBlitzortung';
import { useMemo, useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from '../context/LocaleContext';

function fmt(n: number) { return n.toLocaleString(); }

export default function CountriesPage() {
  const { countryCounts, totalCount } = useBlitzortung();
  const t = useTranslations('countries');
  const { locale } = useLocale();
  // code → timestamp of its last count change; keying rows on this restarts the flash animation
  const [flash, setFlash] = useState<Record<string, number>>({});
  const prevCountsRef = useRef<Record<string, number>>({});
  const [search, setSearch] = useState('');

  useEffect(() => {
    const prev = prevCountsRef.current;
    const changed: Record<string, number> = {};
    const now = Date.now();
    for (const [code, count] of Object.entries(countryCounts)) {
      if (prev[code] !== undefined && prev[code] !== count) changed[code] = now;
      prev[code] = count;
    }
    if (Object.keys(changed).length > 0) setFlash(f => ({ ...f, ...changed }));
  }, [countryCounts]);

  const displayNames = useMemo(() => {
    if (typeof Intl === 'undefined') return null;
    try { return new Intl.DisplayNames([locale], { type: 'region' }); } catch { return null; }
  }, [locale]);

  function countryName(code: string): string {
    try { return displayNames?.of(code) ?? code; } catch { return code; }
  }

  const ranked = useMemo(() => {
    return Object.entries(countryCounts)
      .map(([code, count]) => ({ code, count, name: countryName(code) }))
      .sort((a, b) => b.count - a.count);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryCounts, displayNames]);

  const topCount = ranked[0]?.count ?? 1;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ranked;
    return ranked.filter(({ code, name }) =>
      name.toLowerCase().includes(q) || code.toLowerCase().includes(q)
    );
  }, [ranked, search]);

  return (
    <div className="country-list-page">
      <div className="country-list-header">
        <span className="country-list-title">{t('title')}</span>
        <input
          className="archive-search"
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className="archive-count">{t('countriesFound', { count: filtered.length })}</span>
      </div>

      <div className="country-list-body">
        {filtered.length === 0 ? (
          <div className="country-list-empty">
            {ranked.length === 0 ? t('waiting') : t('countriesFound', { count: 0 })}
          </div>
        ) : (
          <table className="country-list-table">
            <thead>
              <tr>
                <th>{t('country')}</th>
                <th className="cl-num">{t('strikes')}</th>
                <th className="cl-bar-col"></th>
                <th className="cl-pct">{t('share')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ code, count, name }) => (
                <tr key={`${code}:${flash[code] ?? 0}`} className={`cl-row${flash[code] ? ' cl-row-flash' : ''}`}>
                  <td>
                    <div className="cl-country">
                      <img
                        src={`https://flagcdn.com/w20/${code.toLowerCase()}.png`}
                        alt={name}
                        width={20}
                        height={15}
                        className="cl-flag-img"
                        loading="lazy"
                      />
                      <span className="cl-name">{name}</span>
                    </div>
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
