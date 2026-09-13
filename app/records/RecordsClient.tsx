'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../hooks/useCountryName';
import { fmt } from '../lib/format';
import CountryFlag from '../components/CountryFlag';
import StormMetrics from '../components/StormMetrics';
import type { StormLogRow } from '../lib/db';

interface Props {
  dailyBest: StormLogRow[];
  top100: StormLogRow[];
}

type TableView = 'day' | 'alltime';

function tier(rank: number): string {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  if (rank <= 10) return 'top10';
  return '';
}

export default function RecordsClient({ dailyBest, top100 }: Props) {
  const t = useTranslations('records');
  const stats = useTranslations('stats');
  const ts = useTranslations('storms');
  const countryName = useCountryName();
  const [view, setView] = useState<TableView>('day');

  useEffect(() => {
    try {
      const savedView = localStorage.getItem('records-view') as TableView | null;
      if (savedView === 'alltime') setView('alltime');
    } catch {}
  }, []);

  const baseRows = view === 'alltime' ? top100 : dailyBest;

  // Tag each row with its original rank
  const rankedRows = useMemo(() =>
    baseRows.map((s, i) => ({ s, rank: view === 'alltime' ? i + 1 : null })),
    [baseRows, view]
  );

  function stormName(s: StormLogRow): string {
    const isXO = s.code === 'XO';
    const effCity = s.city ?? (isXO ? 'Open Ocean' : null);
    const effOrigin = s.originCity ?? (isXO ? 'Open Ocean' : null);
    return effOrigin && effCity && effOrigin !== effCity
      ? ts('stormFromTo', { from: effOrigin, to: effCity })
      : effCity
        ? ts('stormNear', { city: effCity })
        : `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`;
  }

  return (
    <div className="archive-page records-page">
      <div className="archive-toolbar">
        <select
          className="storm-table-select"
          aria-label={t('title')}
          value={view}
          onChange={e => {
            const v = e.target.value as TableView;
            setView(v);
            try { localStorage.setItem('records-view', v); } catch {}
          }}
        >
          <option value="day">{t('dailyBest')}</option>
          <option value="alltime">Top {top100.length} all time</option>
        </select>
      </div>

      <div className={`hof-list${view === 'day' ? ' hof-list--norank' : ''}`}>
        {rankedRows.length === 0 ? (
          <div className="archive-empty">{t('noData')}</div>
        ) : rankedRows.map(({ s, rank }) => {
          const t2 = rank ? tier(rank) : '';
          const name = stormName(s);
          const count = s.totalCount ?? s.count;

          const flags = s.countryPath && s.countryPath.length > 1
            ? s.countryPath.map((cc, j) => (
                <span key={cc} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.15rem' }}>
                  {j > 0 && <span className="hof-arrow">›</span>}
                  <CountryFlag code={cc} name={countryName(cc)} />
                </span>
              ))
            : <CountryFlag code={s.code} name={countryName(s.code)} />;

          return (
            <Link
              key={s.stormKey}
              className={`hof-row${t2 ? ` hof-row--${t2}` : ''}`}
              href={`/storms/${encodeURIComponent(s.stormKey)}`}
              prefetch={false}
            >
              {rank && <span className="hof-rank">#{rank}</span>}

              <div className="hof-main">
                <span className="hof-name">{name}</span>
                <span className="hof-flags">
                  {flags}
                  {(!s.countryPath || s.countryPath.length <= 1) && (
                    <span className="hof-country-name">{countryName(s.code)}</span>
                  )}
                </span>
              </div>

              <StormMetrics storm={s} showDate />

              <div className="hof-count-wrap">
                <span className="hof-count">{fmt(count)}</span>
                <span className="hof-count-label">{stats('strikes')}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
