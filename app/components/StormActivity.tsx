'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useBlitzortung } from '../hooks/useBlitzortung';
import { useCountryName } from '../hooks/useCountryName';
import { fmtRate } from '../lib/format';
import CountryFlag from './CountryFlag';

const WINDOW_MS = 5 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000; // rate uses last 1 min for responsiveness
const TOP_N = 15;

const SEA = '--';

interface StormEntry {
  cc: string;
  rate: number;
}

export default function StormActivity() {
  const { strikes, historyLoaded } = useBlitzortung();
  const t = useTranslations('storms');
  const countryName = useCountryName();

  const storms = useMemo<StormEntry[]>(() => {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const rateCutoff = now - RATE_WINDOW_MS;
    const counts: Record<string, number> = {};
    const rateCounts: Record<string, number> = {};
    let seaCount = 0;
    let seaRateCount = 0;
    for (const s of strikes) {
      if (s.time <= cutoff) continue;
      if (s.cc) {
        counts[s.cc] = (counts[s.cc] ?? 0) + 1;
        if (s.time > rateCutoff) rateCounts[s.cc] = (rateCounts[s.cc] ?? 0) + 1;
      } else {
        seaCount++;
        if (s.time > rateCutoff) seaRateCount++;
      }
    }
    const list = Object.entries(counts)
      .map(([cc, count]) => ({ cc, count, rate: rateCounts[cc] ?? 0 }));
    if (seaCount > 0) list.push({ cc: SEA, count: seaCount, rate: seaRateCount });
    return list
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_N)
      .map(({ cc, rate }) => ({ cc, rate }));
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
                <th>{t('country')}</th>
                <th className="storm-col-rate">{t('rateHeader')}</th>
              </tr>
            </thead>
            <tbody>
              {storms.map(({ cc, rate }, i) => {
                const isSea = cc === SEA;
                return (
                  <tr key={cc} className={`storm-row storm-row-${i + 1}`}>
                    <td className="storm-col-country">
                      {isSea ? <span className="storm-sea-icon">🌊</span> : <CountryFlag code={cc} name={countryName(cc)} />}
                      <span>{isSea ? t('atSea') : countryName(cc)}</span>
                    </td>
                    <td className="storm-col-rate storm-rate">
                      {fmtRate(rate)}
                      <span className="storm-rate-unit">/m</span>
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
