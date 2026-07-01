'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLocale } from '../../context/LocaleContext';

function fmt(n: number) { return n.toLocaleString(); }

interface ArchiveRow { code: string; today: number; peakCount: number; peakDate: string; }
interface HistoryRow { date: string; count: number; }

export default function CountryDetailPage() {
  const params = useParams();
  const code = (params.code as string).toUpperCase();
  const router = useRouter();
  const t = useTranslations('stats');
  const { locale } = useLocale();

  const [row, setRow] = useState<ArchiveRow | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [minStrikes, setMinStrikes] = useState('');

  const displayNames = useMemo(() => {
    if (typeof Intl === 'undefined') return null;
    try { return new Intl.DisplayNames([locale], { type: 'region' }); } catch { return null; }
  }, [locale]);

  function countryName(c: string): string {
    try { return displayNames?.of(c) ?? c; } catch { return c; }
  }

  useEffect(() => {
    fetch('/api/archive')
      .then(r => r.json())
      .then((data: ArchiveRow[]) => setRow(data.find(d => d.code === code) ?? null))
      .catch(() => {});
    fetch(`/api/country/${code}`)
      .then(r => r.json())
      .then(setHistory)
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
            <img
              src={`https://flagcdn.com/w20/${code.toLowerCase()}.png`}
              alt={countryName(code)}
              width={20}
              height={15}
              className="cl-flag-img"
            />
            <div className="detail-head-info">
              <span className="detail-country-name">{countryName(code)}</span>
              {row && (
                <div className="detail-meta">
                  <span>{t('todayLabel')} <strong>{fmt(row.today)}</strong></span>
                  <span>{t('peakLabel')} <strong>{fmt(row.peakCount)}</strong> {t('on')} {row.peakDate || '—'}</span>
                </div>
              )}
            </div>
          </div>
        </div>

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
