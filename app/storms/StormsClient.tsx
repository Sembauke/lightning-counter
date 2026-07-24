'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../hooks/useCountryName';
import { fmtRate, fmtClock, fmtDuration } from '../lib/format';
import CountryFlag from '../components/CountryFlag';
import type { StormLogRow, StormStrike } from '../lib/db';

// The API adds originCode when a storm crossed a border since it started
type StormRow = StormLogRow & { originCode?: string | null; rank?: number | null };

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function rankStyle(rank: number): React.CSSProperties {
  const t = Math.pow(Math.max(0, 1 - (rank - 1) / 99), 0.5);
  // #1 = blazing gold (50°), fades through orange-red to grey
  const hue = Math.round(50 - t * 20);   // 50° gold → 30° orange
  const sat = Math.round(30 + t * 70);   // 30% muted → 100% vivid
  const light = Math.round(40 + t * 35); // 40% dim → 75% bright
  return {
    color: `hsl(${hue}, ${sat}%, ${light}%)`,
    background: `hsla(${hue}, ${sat}%, ${light}%, ${0.1 + t * 0.35})`,
    borderColor: `hsla(${hue}, ${sat}%, ${light}%, ${0.25 + t * 0.65})`,
    fontWeight: t > 0.7 ? 700 : undefined,
  };
}

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
  const [flashKeys, setFlashKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const isToday = date === todayUTC();

    async function load(isFirstLoad: boolean) {
      if (cancelled) return;
      try {
        const rows: StormRow[] = await fetch(`/api/storms?date=${date}`).then(r => r.json());
        if (cancelled) return;
        if (!isFirstLoad) {
          setStorms(prev => {
            const changed = new Set<string>();
            const prevMap = new Map(prev.map(p => [p.stormKey, p.count]));
            for (const row of rows) {
              if (prevMap.has(row.stormKey) && prevMap.get(row.stormKey) !== row.count)
                changed.add(row.stormKey);
            }
            if (changed.size > 0) {
              setFlashKeys(changed);
              setTimeout(() => setFlashKeys(new Set()), 1000);
            }
            return rows;
          });
        } else {
          setStorms(rows);
        }
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    }

    setLoaded(false);
    setStorms([]);
    load(true);

    if (!isToday) return () => { cancelled = true; };
    const timer = setInterval(() => { if (!document.hidden) load(false); }, 5_000);
    return () => { cancelled = true; clearInterval(timer); };
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
              const isLive = date === todayUTC() && s.endTime != null && Date.now() - s.endTime < 10 * 60 * 1000;
              return (
                <div key={s.stormKey} className={`storm-log-row${open ? ' open' : ''}${flashKeys.has(s.stormKey) ? ' flash' : ''}`}>
                  <button className="storm-log-head" onClick={() => setExpandedKey(open ? null : s.stormKey)}>
                    {/* Row 1: country path + badges */}
                    <div className="storm-log-top">
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
                      <span className="storm-log-badges">
                        {isLive && (
                          <Link href={`/?lat=${s.lat}&lon=${s.lon}`} className="storm-live-tag" onClick={e => e.stopPropagation()}>LIVE</Link>
                        )}
                        {s.rank != null && (
                          <span className="storm-log-rank" style={rankStyle(s.rank)}>{ordinal(s.rank)} biggest</span>
                        )}
                        <span className={`storm-chevron${open ? ' open' : ''}`}>▾</span>
                      </span>
                    </div>
                    {/* Row 2: storm name */}
                    <span className="storm-log-name">
                      {s.originCity && s.city && s.originCity !== s.city
                        ? ts('stormFromTo', { from: s.originCity, to: s.city })
                        : s.city
                          ? ts('stormNear', { city: s.city })
                          : `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`}
                    </span>
                    {/* Row 3: stats */}
                    <div className="storm-log-stats">
                      <span>{ts('strikesCount', { count: s.totalCount ?? s.count })}</span>
                      <span>{ts('peakRate', { rate: fmtRate(s.rate) })}</span>
                      {s.startTime != null && s.endTime != null && (
                        <>
                          <span>{fmtDuration(s.endTime - s.startTime)}</span>
                          <span>{fmtClock(s.startTime)} – {fmtClock(s.endTime)}</span>
                        </>
                      )}
                      {s.traveledKm != null && s.traveledKm >= 5 && (
                        <span>{ts('traveled', { km: Math.round(s.traveledKm) })}</span>
                      )}
                    </div>
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
