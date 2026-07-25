'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../hooks/useCountryName';
import { fmtRate, fmtClock, fmtDuration } from '../lib/format';
import CountryFlag from '../components/CountryFlag';
import type { GlobalStormRecord, StormRecordCategory, StormLogRow } from '../lib/db';

const StormReplayMap = dynamic(() => import('../components/StormReplayMap'), { ssr: false });

const CATEGORY_ORDER: StormRecordCategory[] = ['biggest', 'longest', 'farthest'];

interface Props {
  storms: GlobalStormRecord[];
  dailyBest: StormLogRow[];
  top100: StormLogRow[];
}

type TableView = 'day' | 'alltime';

export default function RecordsClient({ storms, dailyBest, top100 }: Props) {
  const t = useTranslations('records');
  const ts = useTranslations('storms');
  const countryName = useCountryName();
  const [view, setView] = useState<TableView>('day');

  const byCategory = new Map(storms.map(s => [s.category, s]));

  function highlight(rec: GlobalStormRecord): string {
    switch (rec.category) {
      case 'biggest': return ts('peakRate', { rate: fmtRate(rec.rate) });
      case 'longest': return rec.startTime != null && rec.endTime != null ? fmtDuration(rec.endTime - rec.startTime) : '';
      case 'farthest': return ts('traveled', { km: Math.round(rec.traveledKm ?? 0) });
      default: return '';
    }
  }

  function stormName(s: StormLogRow) {
    return s.originCity && s.city && s.originCity !== s.city
      ? ts('stormFromTo', { from: s.originCity, to: s.city })
      : s.city
        ? ts('stormNear', { city: s.city })
        : `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`;
  }

  function flags(s: StormLogRow) {
    return s.countryPath && s.countryPath.length > 1
      ? s.countryPath.map((cc, i) => (
          <span key={cc} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
            {i > 0 && <span className="storm-log-arrow">→</span>}
            <CountryFlag code={cc} name={countryName(cc)} />
          </span>
        ))
      : <CountryFlag code={s.code} name={countryName(s.code)} />;
  }

  const rows = view === 'alltime' ? top100 : dailyBest;

  return (
    <div className="archive-page">
      <div className="archive-toolbar">
        <span className="archive-title">{t('title')}</span>
      </div>

      <div className="records-body">
        {storms.length === 0 ? (
          <div className="archive-empty">{t('noData')}</div>
        ) : (
          <>
            <div className="records-grid">
              {CATEGORY_ORDER.map(cat => {
                const rec = byCategory.get(cat);
                if (!rec) return null;
                const cardClass = `rec-card${rec.stormKey ? ' rec-card--link' : ''}`;
                const cardContents = (
                  <>
                    <div className="rec-header">
                      <span className="bsc-title">{t(cat)}</span>
                      <span className="rec-highlight">{highlight(rec)}</span>
                    </div>
                    <span className="rec-country">
                      {rec.countryPath && rec.countryPath.length > 1
                        ? rec.countryPath.map((cc, i) => (
                            <span key={cc} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                              {i > 0 && <span className="storm-log-arrow">→</span>}
                              <CountryFlag code={cc} name={countryName(cc)} />
                              {countryName(cc)}
                            </span>
                          ))
                        : (<><CountryFlag code={rec.code} name={countryName(rec.code)} />{countryName(rec.code)}</>)}
                    </span>
                    <span className="bsc-name">
                      {rec.originCity && rec.city && rec.originCity !== rec.city
                        ? ts('stormFromTo', { from: rec.originCity, to: rec.city })
                        : rec.city
                          ? ts('stormNear', { city: rec.city })
                          : `${rec.lat.toFixed(2)}, ${rec.lon.toFixed(2)}`}
                    </span>
                    <span className="bsc-meta">
                      {ts('strikesCount', { count: rec.totalCount ?? rec.count })}
                      {' · '}
                      {ts('peakRate', { rate: fmtRate(rec.rate) })}
                      {rec.traveledKm != null && rec.traveledKm >= 5 && (
                        <> · {ts('traveled', { km: Math.round(rec.traveledKm) })}</>
                      )}
                    </span>
                    <span className="bsc-meta">
                      {rec.date}
                      {rec.startTime && rec.endTime && (
                        <> · {fmtClock(rec.startTime)} – {fmtClock(rec.endTime)} · {fmtDuration(rec.endTime - rec.startTime)}</>
                      )}
                    </span>
                    {rec.strikes && rec.strikes.length > 0 && <StormReplayMap strikes={rec.strikes} />}
                  </>
                );
                return rec.stormKey
                  ? <Link key={cat} href={`/storms/${encodeURIComponent(rec.stormKey)}`} className={cardClass}>{cardContents}</Link>
                  : <div key={cat} className={cardClass}>{cardContents}</div>;
              })}
            </div>

            {rows.length > 0 && (
              <div className="storm-table-section">
                <div className="storm-table-header">
                  <select
                    className="storm-table-select"
                    value={view}
                    onChange={e => setView(e.target.value as TableView)}
                  >
                    <option value="day">{t('dailyBest')}</option>
                    <option value="alltime">Top {top100.length} all time</option>
                  </select>
                </div>
                <div className="storm-table">
                  {rows.map((s, i) => (
                    <Link key={s.stormKey} href={`/storms/${encodeURIComponent(s.stormKey)}`} className={`storm-table-row${view === 'alltime' ? ' has-rank' : ''}`}>
                      {view === 'alltime' && (
                        <span className="storm-table-rank">#{i + 1}</span>
                      )}
                      <span className="storm-table-date">{s.date}</span>
                      <span className="storm-table-flags">{flags(s)}</span>
                      <span className="storm-table-info">
                        <span className="storm-table-name">{stormName(s)}</span>
                        <span className="storm-table-stats">
                          {ts('strikesCount', { count: s.totalCount ?? s.count })}
                          {' · '}{ts('peakRate', { rate: fmtRate(s.rate) })}
                          {s.startTime != null && s.endTime != null && (
                            <> · {fmtDuration(s.endTime - s.startTime)}</>
                          )}
                        </span>
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
