'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLocale } from '../context/LocaleContext';

function fmt(n: number) { return n.toLocaleString(); }

type SortCol = 'name' | 'today' | 'peak';
type SortDir = 'asc' | 'desc';

interface ArchiveRow { code: string; today: number; peakCount: number; peakDate: string; }

export default function ArchivePage() {
  const [data, setData] = useState<ArchiveRow[]>([]);
  // code → timestamp of its last count change; keying rows on this restarts the flash animation
  const [flash, setFlash] = useState<Record<string, number>>({});
  const prevTodayRef = useRef<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('today');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const t = useTranslations('stats');
  const { locale } = useLocale();
  const router = useRouter();

  const displayNames = useMemo(() => {
    if (typeof Intl === 'undefined') return null;
    try { return new Intl.DisplayNames([locale], { type: 'region' }); } catch { return null; }
  }, [locale]);

  function countryName(code: string): string {
    try { return displayNames?.of(code) ?? code; } catch { return code; }
  }

  useEffect(() => {
    const load = () => fetch('/api/archive')
      .then(r => r.json())
      .then((rows: ArchiveRow[]) => {
        const prev = prevTodayRef.current;
        const changed: Record<string, number> = {};
        const now = Date.now();
        for (const row of rows) {
          if (prev[row.code] !== undefined && prev[row.code] !== row.today) changed[row.code] = now;
          prev[row.code] = row.today;
        }
        if (Object.keys(changed).length > 0) setFlash(f => ({ ...f, ...changed }));
        setData(rows);
      })
      .catch(() => {});
    load();
    // Counts are served from the server's live in-memory counters, so a short
    // interval gives near-real-time updates
    const timer = setInterval(load, 2_500);
    return () => clearInterval(timer);
  }, []);

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortCol(col);
      setSortDir(col === 'name' ? 'asc' : 'desc');
    }
  };

  const sortIndicator = (col: SortCol) =>
    sortCol === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const rows = q
      ? data.filter(row =>
          countryName(row.code).toLowerCase().includes(q) || row.code.toLowerCase().includes(q)
        )
      : [...data];

    rows.sort((a, b) => {
      let cmp = 0;
      if (sortCol === 'name') {
        cmp = countryName(a.code).localeCompare(countryName(b.code), locale);
      } else if (sortCol === 'today') {
        cmp = a.today - b.today;
      } else {
        cmp = a.peakCount - b.peakCount;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return rows;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, search, sortCol, sortDir, displayNames]);

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

      <div className="archive-body">
        <table className="archive-table">
          <thead>
            <tr>
              <th className="th-sort" onClick={() => handleSort('name')}>
                {t('country')}{sortIndicator('name')}
              </th>
              <th className="col-num th-sort" onClick={() => handleSort('today')}>
                {t('today')}{sortIndicator('today')}
              </th>
              <th className="col-num th-sort" title={t('peakTooltip')} onClick={() => handleSort('peak')}>
                {t('allTimeHigh')}{sortIndicator('peak')}
              </th>
              <th className="col-date">{t('date')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={4} className="archive-empty">{t('noData')}</td></tr>
            )}
            {filtered.map(row => (
              <tr
                key={`${row.code}:${flash[row.code] ?? 0}`}
                className={`archive-row${flash[row.code] ? ' archive-row-flash' : ''}`}
                onClick={() => router.push(`/stats/${row.code}`)}
                style={{ cursor: 'pointer' }}
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
    </div>
  );
}
