'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../../hooks/useCountryName';
import { fmt, fmtRate, fmtClock } from '../../lib/format';
import CountryFlag from '../../components/CountryFlag';
import { watchCountryDetail, type CountryDetail } from '../../lib/countryDetailRefresh';

const StormReplayMap = dynamic(() => import('../../components/StormReplayMap'), { ssr: false });

export default function CountryClient() {
  const params = useParams();
  const code = (params.code as string).toUpperCase();
  const t = useTranslations('stats');
  const ts = useTranslations('storms');
  const countryName = useCountryName();

  const [data, setData] = useState<CountryDetail | null>(null);
  const current = data?.row.code === code ? data : null;
  const row = current?.row;
  const history = current?.history;
  const biggestStorm = current?.biggestStorm;
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [minStrikes, setMinStrikes] = useState('');

  useEffect(() => watchCountryDetail(code, setData), [code]);

  const filteredHistory = useMemo(() => (history ?? []).filter(h => {
    if (dateFrom && h.date < dateFrom) return false;
    if (dateTo && h.date > dateTo) return false;
    if (minStrikes && h.count < parseInt(minStrikes, 10)) return false;
    return true;
  }), [history, dateFrom, dateTo, minStrikes]);

  return (
    <div className="archive-page">
      <div className="archive-detail standalone">
        <div className="detail-head">
          <div className="detail-head-main">
            <CountryFlag code={code} name={countryName(code)} />
            <div className="detail-head-info">
              <span className="detail-country-name">{countryName(code)}</span>
              {row && (
                <div className="detail-meta">
                  <span>{t('todayLabel')} <strong>{fmt(row.today)}</strong></span>
                  <span title={t('peakTooltip')}>{t('peakLabel')} <strong>{fmt(row.peakCount)}</strong> {t('on')} {row.peakDate || '—'}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {biggestStorm && (
          <div className="biggest-storm-card">
            <span className="bsc-title">{t('biggestStorm')}</span>
            <span className="bsc-name">
              ⚡ {(() => {
                const ec = biggestStorm.city ?? (code === 'XO' ? 'Open Ocean' : null);
                const eo = biggestStorm.originCity ?? (code === 'XO' ? 'Open Ocean' : null);
                return eo && ec && eo !== ec
                  ? ts('stormFromTo', { from: eo, to: ec })
                  : ec
                    ? ts('stormNear', { city: ec })
                    : `${biggestStorm.lat.toFixed(2)}, ${biggestStorm.lon.toFixed(2)}`;
              })()}
            </span>
            <span className="bsc-meta">
              {ts('strikesCount', { count: biggestStorm.totalCount ?? biggestStorm.count })}
              {' · '}
              {ts('peakRate', { rate: fmtRate(biggestStorm.rate) })}
              {' · '}
              {biggestStorm.date}
              {biggestStorm.startTime && biggestStorm.endTime && (
                <> · {fmtClock(biggestStorm.startTime)} – {fmtClock(biggestStorm.endTime)}</>
              )}
              {biggestStorm.traveledKm != null && biggestStorm.traveledKm >= 5 && (
                <> · {ts('traveled', { km: biggestStorm.traveledKm })}</>
              )}
            </span>
            {biggestStorm.strikes && biggestStorm.strikes.length > 0 && (
              <StormReplayMap strikes={biggestStorm.strikes} />
            )}
          </div>
        )}

        <div className="detail-filters">
          <label>{t('from')} <input type="date" className="detail-input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></label>
          <label>{t('to')} <input type="date" className="detail-input" value={dateTo} onChange={e => setDateTo(e.target.value)} /></label>
          <label>{t('minStrikes')} <input className="detail-input detail-input-sm" value={minStrikes} onChange={e => setMinStrikes(e.target.value)} placeholder="0" /></label>
        </div>

        <div className="detail-body">
          <table className="detail-table">
            <thead><tr><th>{t('date')}</th><th className="col-num">{t('strikes')}</th></tr></thead>
            <tbody>
              {filteredHistory.length === 0
                ? <tr><td colSpan={2} className="archive-empty">{t('noRecords')}</td></tr>
                : filteredHistory.map(h => (
                  <tr key={h.date}>
                    <td>{h.date}</td>
                    <td className="col-num detail-count">{fmt(h.count)}</td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
