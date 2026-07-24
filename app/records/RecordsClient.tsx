'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../hooks/useCountryName';
import { fmtRate, fmtClock, fmtDuration } from '../lib/format';
import CountryFlag from '../components/CountryFlag';
import type { GlobalStormRecord, StormRecordCategory, StormLogRow } from '../lib/db';

const StormReplayMap = dynamic(() => import('../components/StormReplayMap'), { ssr: false });

const CATEGORY_ORDER: StormRecordCategory[] = ['biggest', 'longest', 'farthest'];

export default function RecordsClient() {
  const t = useTranslations('records');
  const ts = useTranslations('storms');
  const countryName = useCountryName();
  const [storms, setStorms] = useState<GlobalStormRecord[]>([]);
  const [dailyBest, setDailyBest] = useState<StormLogRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/records')
      .then(r => r.json())
      .then((data: { storms: GlobalStormRecord[]; dailyBest: StormLogRow[] }) => {
        setStorms(data.storms);
        setDailyBest(data.dailyBest ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const byCategory = new Map(storms.map(s => [s.category, s]));

  function highlight(rec: GlobalStormRecord): string {
    switch (rec.category) {
      case 'biggest': return ts('peakRate', { rate: fmtRate(rec.rate) });
      case 'longest': return rec.startTime != null && rec.endTime != null ? fmtDuration(rec.endTime - rec.startTime) : '';
      case 'farthest': return ts('traveled', { km: Math.round(rec.traveledKm ?? 0) });
      default: return '';
    }
  }

  return (
    <div className="archive-page">
      <div className="archive-toolbar">
        <span className="archive-title">{t('title')}</span>
      </div>

      <div className="records-body">
        {!loaded ? null : storms.length === 0 ? (
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

          {dailyBest.length > 0 && (
            <div className="daily-best-section">
              <div className="daily-best-title">{t('dailyBest')}</div>
              <div className="daily-best-list">
                {dailyBest.map(s => (
                  <Link key={s.stormKey} href={`/storms/${encodeURIComponent(s.stormKey)}`} className="daily-best-row">
                    <span className="daily-best-date">{s.date}</span>
                    <span className="daily-best-country">
                      {s.countryPath && s.countryPath.length > 1
                        ? s.countryPath.map((cc, i) => (
                            <span key={cc} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                              {i > 0 && <span className="storm-log-arrow">→</span>}
                              <CountryFlag code={cc} name={countryName(cc)} />
                            </span>
                          ))
                        : <CountryFlag code={s.code} name={countryName(s.code)} />}
                    </span>
                    <span className="daily-best-name">
                      {s.originCity && s.city && s.originCity !== s.city
                        ? ts('stormFromTo', { from: s.originCity, to: s.city })
                        : s.city
                          ? ts('stormNear', { city: s.city })
                          : `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`}
                    </span>
                    <span className="daily-best-stats">
                      {ts('peakRate', { rate: fmtRate(s.rate) })}
                      {s.startTime != null && s.endTime != null && (
                        <> · {fmtClock(s.startTime)} – {fmtClock(s.endTime)}</>
                      )}
                      {s.traveledKm != null && s.traveledKm >= 5 && (
                        <> · {ts('traveled', { km: Math.round(s.traveledKm) })}</>
                      )}
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
