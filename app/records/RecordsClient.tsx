'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../hooks/useCountryName';
import { fmtRate, fmtDuration, fmt } from '../lib/format';
import CountryFlag from '../components/CountryFlag';
import type { StormLogRow } from '../lib/db';

interface Props {
  dailyBest: StormLogRow[];
  top100: StormLogRow[];
}

type TableView = 'day' | 'alltime';

interface Filters {
  minPeak: number;       // strikes/min
  minDuration: number;   // ms
  minCountries: number;  // count
  minDistance: number;   // km
}

const DEFAULT_FILTERS: Filters = { minPeak: 0, minDuration: 0, minCountries: 0, minDistance: 0 };

const DURATION_OPTIONS = [
  { label: 'any',  value: 0 },
  { label: '30m+', value: 30 * 60_000 },
  { label: '1h+',  value: 60 * 60_000 },
  { label: '2h+',  value: 2 * 60 * 60_000 },
  { label: '4h+',  value: 4 * 60 * 60_000 },
  { label: '8h+',  value: 8 * 60 * 60_000 },
  { label: '12h+', value: 12 * 60 * 60_000 },
];

const COUNTRIES_OPTIONS = [
  { label: 'any', value: 0 },
  { label: '2+',  value: 2 },
  { label: '3+',  value: 3 },
  { label: '4+',  value: 4 },
  { label: '5+',  value: 5 },
];

const DISTANCE_OPTIONS = [
  { label: 'any',     value: 0 },
  { label: '50km+',   value: 50 },
  { label: '100km+',  value: 100 },
  { label: '250km+',  value: 250 },
  { label: '500km+',  value: 500 },
  { label: '1000km+', value: 1000 },
];

function tier(rank: number): string {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  if (rank <= 10) return 'top10';
  return '';
}

function hasActiveFilters(f: Filters): boolean {
  return f.minPeak > 0 || f.minDuration > 0 || f.minCountries > 0 || f.minDistance > 0;
}

export default function RecordsClient({ dailyBest, top100 }: Props) {
  const router = useRouter();
  const t = useTranslations('records');
  const ts = useTranslations('storms');
  const countryName = useCountryName();
  const [view, setView] = useState<TableView>('day');
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);

  useEffect(() => {
    try {
      const savedView = localStorage.getItem('records-view') as TableView | null;
      if (savedView === 'alltime') setView('alltime');
      const savedFilters = localStorage.getItem('records-filters');
      if (savedFilters) setFilters({ ...DEFAULT_FILTERS, ...JSON.parse(savedFilters) });
    } catch {}
  }, []);

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters(prev => {
      const next = { ...prev, [key]: value };
      try { localStorage.setItem('records-filters', JSON.stringify(next)); } catch {}
      return next;
    });
  }

  function clearFilters() {
    setFilters(DEFAULT_FILTERS);
    try { localStorage.removeItem('records-filters'); } catch {}
  }

  const baseRows = view === 'alltime' ? top100 : dailyBest;

  // Tag each row with its original rank before filtering
  const rankedRows = useMemo(() =>
    baseRows.map((s, i) => ({ s, rank: view === 'alltime' ? i + 1 : null })),
    [baseRows, view]
  );

  const filtered = useMemo(() => {
    const { minPeak, minDuration, minCountries, minDistance } = filters;
    return rankedRows.filter(({ s }) => {
      if (minPeak > 0 && s.rate < minPeak) return false;
      if (minDuration > 0) {
        if (s.startTime == null || s.endTime == null) return false;
        if (s.endTime - s.startTime < minDuration) return false;
      }
      if (minCountries > 0 && (s.countryPath?.length ?? 1) < minCountries) return false;
      if (minDistance > 0 && (s.traveledKm ?? 0) < minDistance) return false;
      return true;
    });
  }, [rankedRows, filters]);

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

  const active = hasActiveFilters(filters);
  const showing = filtered.length;
  const total = baseRows.length;

  return (
    <div className="archive-page">
      <div className="archive-toolbar">
        <span className="archive-title">{t('title')}</span>
        <select
          className="storm-table-select"
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
        {active && (
          <span className="hof-filter-count">
            {showing} / {total}
          </span>
        )}
      </div>

      <div className="hof-filters">
        <label className="hof-filter-field">
          <span className="hof-filter-label">Peak ≥</span>
          <input
            className="hof-filter-input"
            type="number"
            min={0}
            step={50}
            placeholder="any"
            value={filters.minPeak || ''}
            onChange={e => updateFilter('minPeak', Math.max(0, Number(e.target.value) || 0))}
          />
          <span className="hof-filter-unit">/m</span>
        </label>

        <label className="hof-filter-field">
          <span className="hof-filter-label">Duration ≥</span>
          <select
            className="storm-table-select"
            value={filters.minDuration}
            onChange={e => updateFilter('minDuration', Number(e.target.value))}
          >
            {DURATION_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <label className="hof-filter-field">
          <span className="hof-filter-label">Countries ≥</span>
          <select
            className="storm-table-select"
            value={filters.minCountries}
            onChange={e => updateFilter('minCountries', Number(e.target.value))}
          >
            {COUNTRIES_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <label className="hof-filter-field">
          <span className="hof-filter-label">Distance ≥</span>
          <select
            className="storm-table-select"
            value={filters.minDistance}
            onChange={e => updateFilter('minDistance', Number(e.target.value))}
          >
            {DISTANCE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        {active && (
          <button className="hof-filter-clear" onClick={clearFilters}>
            ✕ clear
          </button>
        )}
      </div>

      <div className={`hof-list${view === 'day' ? ' hof-list--norank' : ''}`}>
        {filtered.length === 0 ? (
          <div className="archive-empty">
            {baseRows.length === 0 ? t('noData') : 'No storms match the current filters.'}
          </div>
        ) : filtered.map(({ s, rank }) => {
          const t2 = rank ? tier(rank) : '';
          const name = stormName(s);
          const count = s.totalCount ?? s.count;
          const hasDuration = s.startTime != null && s.endTime != null;

          const flags = s.countryPath && s.countryPath.length > 1
            ? s.countryPath.map((cc, j) => (
                <span key={cc} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.15rem' }}>
                  {j > 0 && <span className="hof-arrow">›</span>}
                  <CountryFlag code={cc} name={countryName(cc)} />
                </span>
              ))
            : <CountryFlag code={s.code} name={countryName(s.code)} />;

          return (
            <div
              key={s.stormKey}
              className={`hof-row${t2 ? ` hof-row--${t2}` : ''}`}
              onClick={() => router.push(`/storms/${encodeURIComponent(s.stormKey)}`)}
              role="link"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && router.push(`/storms/${encodeURIComponent(s.stormKey)}`)}
            >
              {rank && <span className="hof-rank">#{rank}</span>}

              <div className="hof-main">
                <span className="hof-name">{name}</span>
                <span className="hof-sub">
                  <span className="hof-flags">{flags}</span>
                  <span className="hof-sub-stats">
                    <span>{fmtRate(s.rate)}/m</span>
                    {hasDuration && <span>{fmtDuration(s.endTime! - s.startTime!)}</span>}
                    {s.traveledKm != null && s.traveledKm >= 5 && (
                      <span>{Math.round(s.traveledKm)}km</span>
                    )}
                    <span className="hof-sub-date">{s.date}</span>
                  </span>
                </span>
              </div>

              <div className="hof-count-wrap">
                <span className="hof-count">{fmt(count)}</span>
                <span className="hof-count-label">strikes</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
