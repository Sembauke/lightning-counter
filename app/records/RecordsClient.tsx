'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../hooks/useCountryName';
import { fmtRate, fmtClock, fmtDuration } from '../lib/format';
import CountryFlag from '../components/CountryFlag';
import type { GlobalStormRecord, StormRecordCategory } from '../lib/db';

const StormReplayMap = dynamic(() => import('../components/StormReplayMap'), { ssr: false });

const CATEGORY_ORDER: StormRecordCategory[] = ['biggest', 'longest', 'farthest', 'fastest'];

export default function RecordsClient() {
  const t = useTranslations('records');
  const ts = useTranslations('storms');
  const countryName = useCountryName();
  const [storms, setStorms] = useState<GlobalStormRecord[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/records')
      .then(r => r.json())
      .then((data: { storms: GlobalStormRecord[] }) => {
        setStorms(data.storms);
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
      case 'fastest': {
        if (rec.traveledKm == null || rec.startTime == null || rec.endTime == null) return '';
        const kmh = rec.traveledKm / ((rec.endTime - rec.startTime) / 3_600_000);
        return `${Math.round(kmh)} km/h`;
      }
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
          <div className="records-grid">
            {CATEGORY_ORDER.map(cat => {
              const rec = byCategory.get(cat);
              if (!rec) return null;
              return (
                <div key={cat} className="rec-card">
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
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
