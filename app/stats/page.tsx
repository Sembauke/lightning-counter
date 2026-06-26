'use client';

import { useState, useEffect, useMemo } from 'react';

const dn = typeof Intl !== 'undefined' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
function countryName(code: string): string {
  try { return dn?.of(code) ?? code; } catch { return code; }
}
function toFlag(code: string): string {
  if (code.length !== 2) return '';
  return [...code.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
}
function fmt(n: number) { return n.toLocaleString('en-US'); }

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

  useEffect(() => {
    const load = () => fetch('/api/archive').then(r => r.json()).then(setData).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
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
  }, [data, search]);

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
        <span className="archive-title">Strike Archive</span>
        <input
          className="archive-search"
          placeholder="Search country…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className="archive-count">{filtered.length} countries</span>
      </div>

      <div className={`archive-body${selected ? ' has-detail' : ''}`}>
        <table className="archive-table">
          <thead>
            <tr>
              <th>Country</th>
              <th className="col-num">Today</th>
              <th className="col-num">All-Time High</th>
              <th className="col-date">Date</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={4} className="archive-empty">No data yet — strikes accumulate over time.</td></tr>
            )}
            {filtered.map(row => (
              <tr
                key={row.code}
                className={`archive-row${selected === row.code ? ' selected' : ''}`}
                onClick={() => setSelected(selected === row.code ? null : row.code)}
              >
                <td className="col-country">
                  <span className="row-flag">{toFlag(row.code)}</span>
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
            <span className="detail-flag">{toFlag(selected)}</span>
            <span className="detail-country-name">{countryName(selected)}</span>
            <div className="detail-meta">
              <span>Today: <strong>{fmt(selectedRow.today)}</strong></span>
              <span>Peak: <strong>{fmt(selectedRow.peakCount)}</strong> on {selectedRow.peakDate || '—'}</span>
            </div>
            <button className="detail-close" onClick={() => setSelected(null)}>✕</button>
          </div>
          <div className="detail-filters">
            <label>From <input type="date" className="detail-input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></label>
            <label>To <input type="date" className="detail-input" value={dateTo} onChange={e => setDateTo(e.target.value)} /></label>
            <label>Min strikes <input className="detail-input detail-input-sm" value={minStrikes} onChange={e => setMinStrikes(e.target.value)} placeholder="0" /></label>
            {(dateFrom || dateTo || minStrikes) && (
              <button className="detail-clear" onClick={() => { setDateFrom(''); setDateTo(''); setMinStrikes(''); }}>Clear</button>
            )}
          </div>
          <div className="detail-body">
            <table className="detail-table">
              <thead><tr><th>Date</th><th className="col-num">Strikes</th></tr></thead>
              <tbody>
                {filteredHistory.length === 0
                  ? <tr><td colSpan={2} className="archive-empty">No records match the filter.</td></tr>
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
      )}
    </div>
  );
}
