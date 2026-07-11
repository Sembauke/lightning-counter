'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLocale } from '../context/LocaleContext';
import { useCountryName } from '../hooks/useCountryName';
import { fmt } from '../lib/format';
import CountryFlag from '../components/CountryFlag';

type SortCol = 'name' | 'total' | 'today' | 'peak';
type SortDir = 'asc' | 'desc';

interface ArchiveRow { code: string; total: number; today: number; peakCount: number; peakDate: string; }

export default function ArchivePage() {
  const [data, setData] = useState<ArchiveRow[]>([]);
  // code → last increase of its today-count; rendered as a fading "+N" chip
  const [deltas, setDeltas] = useState<Record<string, { amount: number; ts: number }>>({});
  const prevTodayRef = useRef<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('today');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const t = useTranslations('stats');
  const { locale } = useLocale();
  const countryName = useCountryName();
  const router = useRouter();

  useEffect(() => {
    const load = () => fetch('/api/archive')
      .then(r => r.json())
      .then((rows: ArchiveRow[]) => {
        const prev = prevTodayRef.current;
        const changed: Record<string, { amount: number; ts: number }> = {};
        const now = Date.now();
        for (const row of rows) {
          const before = prev[row.code];
          if (before !== undefined && row.today > before) {
            changed[row.code] = { amount: row.today - before, ts: now };
          }
          prev[row.code] = row.today;
        }
        if (Object.keys(changed).length > 0) setDeltas(d => ({ ...d, ...changed }));
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
      } else if (sortCol === 'total') {
        cmp = a.total - b.total;
      } else if (sortCol === 'today') {
        cmp = a.today - b.today;
      } else {
        cmp = a.peakCount - b.peakCount;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return rows;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, search, sortCol, sortDir, locale]);

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
              <th className="col-num th-sort" onClick={() => handleSort('total')}>
                {t('total')}{sortIndicator('total')}
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
              <tr><td colSpan={5} className="archive-empty">{t('noData')}</td></tr>
            )}
            {filtered.map(row => (
              <tr
                key={row.code}
                className="archive-row"
                onClick={() => router.push(`/stats/${row.code}`)}
                style={{ cursor: 'pointer' }}
              >
                <td className="col-country">
                  <CountryFlag code={row.code} name={countryName(row.code)} />
                  <span className="row-name">{countryName(row.code)}</span>
                </td>
                <td className="col-num total-val">{row.total > 0 ? fmt(row.total) : '—'}</td>
                <td className="col-num today-val">
                  <span className="delta-anchor">
                    {deltas[row.code] && (
                      <span className="delta-chip" key={deltas[row.code].ts}>
                        +{fmt(deltas[row.code].amount)}
                      </span>
                    )}
                    {row.today > 0 ? fmt(row.today) : '—'}
                  </span>
                </td>
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
