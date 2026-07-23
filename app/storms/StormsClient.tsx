'use client';

import { useState, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../hooks/useCountryName';
import { fmtRate, fmtClock, fmtDuration } from '../lib/format';
import CountryFlag from '../components/CountryFlag';
import type { StormLogRow, StormStrike } from '../lib/db';

// The API adds originCode when a storm crossed a border since it started
type StormRow = StormLogRow & { originCode?: string | null };

const StormReplayMap = dynamic(() => import('../components/StormReplayMap'), { ssr: false });

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function StormsClient() {
  const t = useTranslations('stormLog');
  const ts = useTranslations('storms');
  const countryName = useCountryName();

  const [date, setDate] = useState(todayUTC);
  const [search, setSearch] = useState('');
  const [storms, setStorms] = useState<StormRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ key: string; strikes: StormStrike[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    const load = () => fetch(`/api/storms?date=${date}`)
      .then(r => r.json())
      .then((rows: StormRow[]) => {
        if (cancelled) return;
        setStorms(rows);
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    load();
    // Today's storms are still growing — keep the list fresh
    const timer = date === todayUTC() ? setInterval(load, 30_000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [date]);

  useEffect(() => {
    if (!expandedKey) { setDetail(null); return; }
    let cancelled = false;
    setDetail(null);
    fetch(`/api/storms?key=${encodeURIComponent(expandedKey)}`)
      .then(r => r.json())
      .then((storm: { strikes: StormStrike[] | null } | null) => {
        if (!cancelled && storm?.strikes) setDetail({ key: expandedKey, strikes: storm.strikes });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [expandedKey]);

  const shiftDate = (days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    const next = d.toISOString().slice(0, 10);
    if (next <= todayUTC()) setDate(next);
    setExpandedKey(null);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return storms;
    return storms.filter(s =>
      countryName(s.code).toLowerCase().includes(q)
      || s.code.toLowerCase().includes(q)
      || (s.city ?? '').toLowerCase().includes(q)
      || (s.originCity ?? '').toLowerCase().includes(q)
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storms, search]);

  return (
    <div className="archive-page">
      <div className="archive-toolbar">
        <span className="archive-title">{t('title')}</span>
        <div className="storm-log-datenav">
          <button className="storm-log-daybtn" onClick={() => shiftDate(-1)} aria-label="‹">‹</button>
          <input
            type="date"
            className="detail-input"
            value={date}
            max={todayUTC()}
            onChange={e => { if (e.target.value) { setDate(e.target.value); setExpandedKey(null); } }}
          />
          <button className="storm-log-daybtn" onClick={() => shiftDate(1)} disabled={date >= todayUTC()} aria-label="›">›</button>
        </div>
        <input
          className="archive-search"
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className="archive-count">{t('stormsFound', { count: filtered.length })}</span>
      </div>

      <div className="records-body">
        {!loaded ? null : filtered.length === 0 ? (
          <div className="archive-empty">{t('noStorms')}</div>
        ) : (
          <div className="storm-log-list">
            {filtered.map(s => {
              const open = expandedKey === s.stormKey;
              return (
                <div key={s.stormKey} className={`storm-log-row${open ? ' open' : ''}`}>
                  <button className="storm-log-head" onClick={() => setExpandedKey(open ? null : s.stormKey)}>
                    <span className="storm-log-country">
                      {s.countryPath && s.countryPath.length > 1
                        ? s.countryPath.map((cc, i) => (
                            <span key={cc} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                              {i > 0 && <span className="storm-log-arrow">→</span>}
                              <CountryFlag code={cc} name={countryName(cc)} />
                              {countryName(cc)}
                            </span>
                          ))
                        : (
                          <>
                            {s.originCode && s.originCode !== s.code && (
                              <>
                                <CountryFlag code={s.originCode} name={countryName(s.originCode)} />
                                {countryName(s.originCode)}
                                <span className="storm-log-arrow">→</span>
                              </>
                            )}
                            <CountryFlag code={s.code} name={countryName(s.code)} />
                            {countryName(s.code)}
                          </>
                        )}
                    </span>
                    <span className="storm-log-name">
                      {s.originCity && s.city && s.originCity !== s.city
                        ? ts('stormFromTo', { from: s.originCity, to: s.city })
                        : s.city
                          ? ts('stormNear', { city: s.city })
                          : `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`}
                    </span>
                    <span className="storm-log-stats">
                      {ts('strikesCount', { count: s.totalCount ?? s.count })}
                      {' · '}
                      {ts('peakRate', { rate: fmtRate(s.rate) })}
                      {s.startTime != null && s.endTime != null && (
                        <> · {fmtDuration(s.endTime - s.startTime)} · {fmtClock(s.startTime)} – {fmtClock(s.endTime)}</>
                      )}
                      {s.traveledKm != null && s.traveledKm >= 5 && (
                        <> · {ts('traveled', { km: Math.round(s.traveledKm) })}</>
                      )}
                    </span>
                    <span className={`storm-chevron${open ? ' open' : ''}`}>▾</span>
                  </button>
                  {open && (
                    detail?.key === s.stormKey
                      ? <StormReplayMap strikes={detail.strikes} />
                      : <div className="storm-log-loading">…</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
