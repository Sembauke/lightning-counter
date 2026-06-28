'use client';

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from '../context/LocaleContext';

function fmt(n: number) { return n.toLocaleString(); }

interface ArchiveRow { code: string; today: number; peakCount: number; peakDate: string; }
interface HistoryRow { date: string; count: number; }

export default function ArchivePage() {
  const [data, setData] = useState<ArchiveRow[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [minStrikes, setMinStrikes] = useState('');
  const t = useTranslations('stats');
  const { locale } = useLocale();

  const displayNames = useMemo(() => {
    if (typeof Intl === 'undefined') return null;
    try { return new Intl.DisplayNames([locale], { type: 'region' }); } catch { return null; }
  }, [locale]);

  function countryName(code: string): string {
    try { return displayNames?.of(code) ?? code; } catch { return code; }
  }

  useEffect(() => {
    const load = () => fetch('/api/archive').then(r => r.json()).then(setData).catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selected) { setHistory([]); return; }
    fetch(`/api/country/${selected}`).then(r => r.json()).then(setHistory).catch(() => {});
  }, [selected]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return data;
    return data.filter(row =>
      countryName(row.code).toLowerCase().includes(q) || row.code.toLowerCase().includes(q)
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, search, displayNames]);

  const filteredHistory = useMemo(() => {
    return history.filter(h => {
      if (dateFrom && h.date < dateFrom) return false;
      if (dateTo && h.date > dateTo) return false;
      if (minStrikes && h.count < parseInt(minStrikes, 10)) return false;
      return true;
    });
  }, [history, dateFrom, dateTo, minStrikes]);

  const selectedRow = selected ? data.find(d => d.code === selected) : null;

  return (
    <div className="archive-page">
      <div className="archive-toolbar">
        <span className="archive-title">{t('title')}</span>
        <input
          className="archive-search"
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className="archive-count">{t('countriesFound', { count: filtered.length })}</span>
      </div>

      <div className={`archive-body${selected ? ' has-detail' : ''}`}>
        <table className="archive-table">
          <thead>
            <tr>
              <th>{t('country')}</th>
              <th className="col-num">{t('today')}</th>
              <th className="col-num">{t('allTimeHigh')}</th>
              <th className="col-date">{t('date')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={4} className="archive-empty">{t('noData')}</td></tr>
            )}
            {filtered.map(row => (
              <tr
                key={row.code}
                className={`archive-row${selected === row.code ? ' selected' : ''}`}
                onClick={() => setSelected(selected === row.code ? null : row.code)}
              >
                <td className="col-country">
                  <img
                    src={`https://flagcdn.com/w20/${row.code.toLowerCase()}.png`}
                    alt={countryName(row.code)}
                    width={20}
                    height={15}
                    className="cl-flag-img"
                    loading="lazy"
                  />
                  <span className="row-name">{countryName(row.code)}</span>
                </td>
                <td className="col-num today-val">{row.today > 0 ? fmt(row.today) : '—'}</td>
                <td className="col-num peak-val">{row.peakCount > 0 ? fmt(row.peakCount) : '—'}</td>
                <td className="col-date">{row.peakDate || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && selectedRow && (
        <div className="archive-detail">
          <div className="detail-head">
            <div className="detail-head-main">
              <img
                src={`https://flagcdn.com/w20/${selected.toLowerCase()}.png`}
                alt={countryName(selected)}
                width={20}
                height={15}
                className="cl-flag-img"
              />
              <div className="detail-head-info">
                <span className="detail-country-name">{countryName(selected)}</span>
                <div className="detail-meta">
                  <span>{t('todayLabel')} <strong>{fmt(selectedRow.today)}</strong></span>
                  <span>{t('peakLabel')} <strong>{fmt(selectedRow.peakCount)}</strong> {t('on')} {selectedRow.peakDate || '—'}</span>
                </div>
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
            <button className="detail-close" onClick={() => setSelected(null)}>{t('close')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
