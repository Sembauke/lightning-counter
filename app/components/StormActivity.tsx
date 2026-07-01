'use client';

import { useMemo, useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from '../context/LocaleContext';
import { useBlitzortung } from '../hooks/useBlitzortung';

const WINDOW_MS = 5 * 60 * 1000;
const TOP_N = 15;

interface StormEntry {
  cc: string;
  count: number;
  rate: number;
}

function fmtRate(r: number) {
  return r >= 10 ? String(Math.round(r)) : r.toFixed(1);
}

export default function StormActivity() {
  const { strikes, historyLoaded } = useBlitzortung();
  const t = useTranslations('storms');
  const { locale } = useLocale();
  const [peakRates, setPeakRates] = useState<Record<string, number>>({});

  useEffect(() => {
    fetch('/api/archive')
      .then(r => r.json())
      .then((rows: Array<{ code: string; peakRate: number }>) => {
        const map: Record<string, number> = {};
        for (const row of rows) if (row.peakRate > 0) map[row.code] = row.peakRate;
        setPeakRates(map);
      })
      .catch(() => {});
  }, []);

  const displayNames = useMemo(() => {
    if (typeof Intl === 'undefined') return null;
    try { return new Intl.DisplayNames([locale], { type: 'region' }); } catch { return null; }
  }, [locale]);

  function countryName(code: string): string {
    try { return displayNames?.of(code) ?? code; } catch { return code; }
  }

  const storms = useMemo<StormEntry[]>(() => {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const counts: Record<string, number> = {};
    for (const s of strikes) {
      if (s.time > cutoff && s.cc) {
        counts[s.cc] = (counts[s.cc] ?? 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([cc, count]) => ({ cc, count, rate: count / 5 }));
  }, [strikes]);

  return (
    <div className="storm-panel">
      <div className="storm-head">
        <div className="storm-head-inner">
          <span className="storm-title">{t('title')}</span>
          <span className="storm-subtitle">{t('window')}</span>
        </div>
      </div>

      <div className="storm-body">
        {!historyLoaded ? (
          <div className="storm-empty">{t('loading')}</div>
        ) : storms.length === 0 ? (
          <div className="storm-empty">{t('noData')}</div>
        ) : (
          <table className="storm-table">
            <thead>
              <tr>
                <th className="storm-col-rank">#</th>
                <th>{t('country')}</th>
                <th className="storm-col-rate">{t('rateHeader')}</th>
                <th className="storm-col-ath">{t('athHeader')}</th>
              </tr>
            </thead>
            <tbody>
              {storms.map(({ cc, rate }, i) => {
                const peak = peakRates[cc];
                return (
                  <tr key={cc} className={`storm-row storm-row-${i + 1}`}>
                    <td className="storm-col-rank storm-rank">{i + 1}</td>
                    <td className="storm-col-country">
                      <img
                        src={`https://flagcdn.com/w20/${cc.toLowerCase()}.png`}
                        alt={countryName(cc)}
                        width={20}
                        height={15}
                        className="cl-flag-img"
                        loading="lazy"
                      />
                      <span>{countryName(cc)}</span>
                    </td>
                    <td className="storm-col-rate storm-rate">
                      {fmtRate(rate)}
                      <span className="storm-rate-unit">/m</span>
                    </td>
                    <td className="storm-col-ath storm-ath">
                      {peak != null ? <>{fmtRate(peak)}<span className="storm-rate-unit">/m</span></> : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}
