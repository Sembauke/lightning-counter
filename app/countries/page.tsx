'use client';

import { useBlitzortung } from '../hooks/useBlitzortung';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from '../context/LocaleContext';

function fmt(n: number) { return n.toLocaleString(); }

export default function CountriesPage() {
  const { countryCounts, totalCount } = useBlitzortung();
  const t = useTranslations('countries');
  const { locale } = useLocale();

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

  return (
    <div className="country-list-page">
      <div className="country-list-header">
        <span className="country-list-title">{t('title')}</span>
        <span className="country-list-meta">{t('totalStrikes', { count: fmt(totalCount) })}</span>
      </div>

      <div className="country-list-body">
        {ranked.length === 0 ? (
          <div className="country-list-empty">{t('waiting')}</div>
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
              {ranked.map(({ code, count, name }) => (
                <tr key={code} className="cl-row">
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
