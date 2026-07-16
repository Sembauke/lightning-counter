'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../hooks/useCountryName';
import { fmt, fmtRate, fmtClock, fmtDuration } from '../lib/format';
import CountryFlag from '../components/CountryFlag';
import type { GlobalStormRecord, StormRecordCategory } from '../lib/db';

const StormReplayMap = dynamic(() => import('../components/StormReplayMap'), { ssr: false });

interface DailyPeak { code: string; count: number; date: string }

const CATEGORY_ORDER: StormRecordCategory[] = ['biggest', 'longest', 'farthest', 'fastest'];

export default function RecordsClient() {
  const t = useTranslations('records');
  const ts = useTranslations('storms');
  const countryName = useCountryName();
  const [storms, setStorms] = useState<GlobalStormRecord[]>([]);
  const [dailyPeak, setDailyPeak] = useState<DailyPeak | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/records')
      .then(r => r.json())
      .then((data: { storms: GlobalStormRecord[]; dailyPeak: DailyPeak | null }) => {
        setStorms(data.storms);
        setDailyPeak(data.dailyPeak);
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
        {!loaded ? null : storms.length === 0 && !dailyPeak ? (
          <div className="archive-empty">{t('noData')}</div>
        ) : (
          <div className="records-grid">
            {CATEGORY_ORDER.map(cat => {
              const rec = byCategory.get(cat);
              if (!rec) return null;
              return (
                <div key={cat} className="rec-card">
                  <span className="bsc-title">{t(cat)}</span>
                  <span className="rec-country">
                    <CountryFlag code={rec.code} name={countryName(rec.code)} />
                    {countryName(rec.code)}
                    <span className="rec-highlight">{highlight(rec)}</span>
                  </span>
                  <span className="bsc-name">
                    ⚡ {rec.originCity && rec.city && rec.originCity !== rec.city
                      ? ts('stormFromTo', { from: rec.originCity, to: rec.city })
                      : rec.city
                        ? ts('stormNear', { city: rec.city })
                        : `${rec.lat.toFixed(2)}, ${rec.lon.toFixed(2)}`}
                  </span>
                  <span className="bsc-meta">
                    {ts('strikesCount', { count: rec.totalCount ?? rec.count })}
                    {' · '}
                    {ts('peakRate', { rate: fmtRate(rec.rate) })}
                    {' · '}
                    {rec.date}
                    {rec.startTime && rec.endTime && (
                      <> · {fmtClock(rec.startTime)} – {fmtClock(rec.endTime)}</>
                    )}
                    {rec.traveledKm != null && rec.traveledKm >= 5 && (
                      <> · {ts('traveled', { km: Math.round(rec.traveledKm) })}</>
                    )}
                  </span>
                  {rec.strikes && rec.strikes.length > 0 && <StormReplayMap strikes={rec.strikes} />}
                </div>
              );
            })}

            {dailyPeak && (
              <div className="rec-card">
                <span className="bsc-title">{t('dailyPeak')}</span>
                <span className="rec-country">
                  <CountryFlag code={dailyPeak.code} name={countryName(dailyPeak.code)} />
                  {countryName(dailyPeak.code)}
                  <span className="rec-highlight">{fmt(dailyPeak.count)}</span>
                </span>
                <span className="bsc-meta">{dailyPeak.date}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
