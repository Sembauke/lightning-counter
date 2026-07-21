'use client';

import { useMemo, useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useBlitzortung } from '../hooks/useBlitzortung';
import { useCountryName } from '../hooks/useCountryName';
import { detectStorms, nearestCity, type CityTuple } from '../lib/stormClusters';
import { fmtRate } from '../lib/format';
import CountryFlag from './CountryFlag';

const WINDOW_MS = 5 * 60 * 1000;
const TOP_N = 15;

const SEA = '--';

interface StormEntry {
  cc: string;
  count: number;
  rate: number;
}

// Per-country city lists, cached for the session
const cityCache = new Map<string, CityTuple[]>();

export default function StormActivity() {
  const { strikes, historyLoaded } = useBlitzortung();
  const t = useTranslations('storms');
  const countryName = useCountryName();
  const [peakRates, setPeakRates] = useState<Record<string, number>>({});
  const [expandedCc, setExpandedCc] = useState<string | null>(null);
  const [cities, setCities] = useState<CityTuple[] | null>(null);

  useEffect(() => {
    fetch('/api/archive')
      .then(r => r.json())
      .then((rows: Array<{ code: string; peakRate: number }>) => {
        const map: Record<string, number> = {};
        for (const row of rows) if (row.peakRate > 0) map[row.code] = row.peakRate;
        setPeakRates(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!expandedCc) return;
    const cached = cityCache.get(expandedCc);
    if (cached) { setCities(cached); return; }
    let cancelled = false;
    setCities(null);
    fetch(`/cities/${expandedCc}.json`)
      .then(r => (r.ok ? r.json() : []))
      .then((list: CityTuple[]) => {
        cityCache.set(expandedCc, list);
        if (!cancelled) setCities(list);
      })
      .catch(() => { if (!cancelled) setCities([]); });
    return () => { cancelled = true; };
  }, [expandedCc]);

  const storms = useMemo<StormEntry[]>(() => {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const counts: Record<string, number> = {};
    let seaCount = 0;
    for (const s of strikes) {
      if (s.time <= cutoff) continue;
      if (s.cc) counts[s.cc] = (counts[s.cc] ?? 0) + 1;
      else seaCount++;
    }
    const list: StormEntry[] = Object.entries(counts)
      .map(([cc, count]) => ({ cc, count, rate: count / 5 }));
    if (seaCount > 0) list.push({ cc: SEA, count: seaCount, rate: seaCount / 5 });
    return list.sort((a, b) => b.count - a.count).slice(0, TOP_N);
  }, [strikes]);

  const cells = useMemo(() => {
    if (!expandedCc) return [];
    const cutoff = Date.now() - WINDOW_MS;
    const subset = expandedCc === SEA
      ? strikes.filter(s => !s.cc && s.time > cutoff)
      : strikes.filter(s => s.cc === expandedCc && s.time > cutoff);
    return detectStorms(subset, WINDOW_MS);
  }, [strikes, expandedCc]);

  function flyTo(lat: number, lon: number, radiusKm: number) {
    window.dispatchEvent(new CustomEvent('lc:flyto', { detail: { lat, lon, radiusKm } }));
  }

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
                <th className="storm-col-rank">#</th>
                <th>{t('country')}</th>
                <th className="storm-col-rate">{t('rateHeader')}</th>
                <th className="storm-col-ath">{t('athHeader')}</th>
              </tr>
            </thead>
            <tbody>
              {storms.map(({ cc, count, rate }, i) => {
                const isSea = cc === SEA;
                const peak = isSea ? undefined : peakRates[cc];
                const isOpen = expandedCc === cc;
                return (
                  <StormRow
                    key={cc}
                    rank={i + 1}
                    cc={cc}
                    name={isSea ? t('atSea') : countryName(cc)}
                    isSea={isSea}
                    count={count}
                    rate={rate}
                    peak={peak}
                    isOpen={isOpen}
                    onToggle={() => setExpandedCc(isOpen ? null : cc)}
                    cells={isOpen ? cells : null}
                    cities={isOpen && !isSea ? cities : []}
                    onFlyTo={flyTo}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}

function StormRow({ rank, cc, name, isSea, count, rate, peak, isOpen, onToggle, cells, cities, onFlyTo }: {
  rank: number;
  cc: string;
  name: string;
  isSea: boolean;
  count: number;
  rate: number;
  peak: number | undefined;
  isOpen: boolean;
  onToggle: () => void;
  cells: ReturnType<typeof detectStorms> | null;
  cities: CityTuple[] | null;
  onFlyTo: (lat: number, lon: number, radiusKm: number) => void;
}) {
  const t = useTranslations('storms');

  return (
    <>
      <tr
        className={`storm-row storm-row-${rank}${isOpen ? ' storm-row-open' : ''}`}
        onClick={onToggle}
        role="button"
        aria-expanded={isOpen}
      >
        <td className="storm-col-rank storm-rank">{rank}</td>
        <td className="storm-col-country">
          {isSea ? <span className="storm-sea-icon">🌊</span> : <CountryFlag code={cc} name={name} />}
          <span>{name}</span>
          <span className={`storm-chevron${isOpen ? ' open' : ''}`}>▾</span>
        </td>
        <td className="storm-col-rate storm-rate">
          {fmtRate(rate)}
          <span className="storm-rate-unit">/m</span>
        </td>
        <td className="storm-col-ath storm-ath">
          {peak != null ? <>{fmtRate(peak)}<span className="storm-rate-unit">/m</span></> : '—'}
        </td>
      </tr>

      {isOpen && (
        <tr className="storm-detail-row">
          <td colSpan={4}>
            <div className="storm-cells">
              <div className="storm-cells-summary">
                {t('activeStorms', { count: cells?.length ?? 0 })}
                {' · '}
                {t('strikesCount', { count })}
              </div>
              {cells === null || cities === null ? (
                <div className="storm-cells-empty">…</div>
              ) : cells.length === 0 ? (
                <div className="storm-cells-empty">{t('noCells')}</div>
              ) : (
                cells.map((cell, idx) => {
                  const near = cities && cities.length > 0 ? nearestCity(cities, cell.lat, cell.lon) : null;
                  return (
                    <button
                      key={idx}
                      className="storm-cell"
                      onClick={(e) => { e.stopPropagation(); onFlyTo(cell.lat, cell.lon, cell.radiusKm); }}
                      title={t('flyTo')}
                    >
                      <span className="storm-cell-main">
                        <span className="storm-cell-name">
                          ⚡ {near ? t('stormNear', { city: near.name }) : `${cell.lat.toFixed(2)}°, ${cell.lon.toFixed(2)}°`}
                        </span>
                        <span className="storm-cell-rate">
                          {fmtRate(cell.rate)}<span className="storm-rate-unit">/m</span>
                          <span
                            className={`storm-trend storm-trend-${cell.trend}`}
                            title={t(cell.trend === 'up' ? 'intensifying' : cell.trend === 'down' ? 'weakening' : 'steady')}
                          >
                            {cell.trend === 'up' ? '▲' : cell.trend === 'down' ? '▼' : '►'}
                          </span>
                        </span>
                      </span>
                      <span className="storm-cell-meta">
                        {near && near.km > 0 ? `${near.km} km ${t(`dir${near.dir}`)} · ` : ''}
                        {t('strikesCount', { count: cell.count })}
                        {cell.drift ? ` · ${t('moving', { dir: t(`dir${cell.drift}`) })}` : ''}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
