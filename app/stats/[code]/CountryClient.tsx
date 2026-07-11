'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../../hooks/useCountryName';
import { fmt, fmtRate } from '../../lib/format';
import CountryFlag from '../../components/CountryFlag';
import type { StormStrike } from '../../lib/db';

const StormReplayMap = dynamic(() => import('./StormReplayMap'), { ssr: false });

interface ArchiveRow { code: string; today: number; peakCount: number; peakDate: string; }
interface HistoryRow { date: string; count: number; }
interface BiggestStorm { count: number; rate: number; lat: number; lon: number; city: string | null; date: string; strikes: StormStrike[] | null; }

export default function CountryClient() {
  const params = useParams();
  const code = (params.code as string).toUpperCase();
  const router = useRouter();
  const t = useTranslations('stats');
  const ts = useTranslations('storms');
  const countryName = useCountryName();

  const [row, setRow] = useState<ArchiveRow | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [biggestStorm, setBiggestStorm] = useState<BiggestStorm | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [minStrikes, setMinStrikes] = useState('');

  useEffect(() => {
    fetch('/api/archive')
      .then(r => r.json())
      .then((data: ArchiveRow[]) => setRow(data.find(d => d.code === code) ?? null))
      .catch(() => {});
    fetch(`/api/country/${code}`)
      .then(r => r.json())
      .then((data: { history: HistoryRow[]; biggestStorm: BiggestStorm | null }) => {
        setHistory(data.history);
        setBiggestStorm(data.biggestStorm);
      })
      .catch(() => {});
  }, [code]);

  const filteredHistory = useMemo(() => history.filter(h => {
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
              ⚡ {biggestStorm.city
                ? ts('stormNear', { city: biggestStorm.city })
                : `${biggestStorm.lat.toFixed(2)}, ${biggestStorm.lon.toFixed(2)}`}
            </span>
            <span className="bsc-meta">
              {ts('strikesCount', { count: biggestStorm.count })}
              {' · '}
              {fmtRate(biggestStorm.rate)}/m
              {' · '}
              {biggestStorm.date}
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

        <div className="detail-footer">
          <button className="detail-close" onClick={() => router.push('/stats')}>← {t('back')}</button>
        </div>
      </div>
    </div>
  );
}
