'use client';

import React, { useState, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../hooks/useCountryName';
import { fmtRate, fmtClock, fmtDuration, fmt } from '../lib/format';
import CountryFlag from '../components/CountryFlag';
import type { StormLogRow, StormStrike } from '../lib/db';
import { useStormMerge } from '../context/StormMergeContext';

type StormRow = StormLogRow & { originCode?: string | null; rank?: number | null };


const StormReplayMap = dynamic(() => import('../components/StormReplayMap'), { ssr: false });

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function StormsClient() {
  const { mergeMap } = useStormMerge();
  const t = useTranslations('stormLog');
  const ts = useTranslations('storms');
  const countryName = useCountryName();
  const [date, setDate] = useState(() => {
    try {
      const saved = localStorage.getItem('stormLogDate');
      if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved) && saved <= todayUTC()) return saved;
    } catch {}
    return todayUTC();
  });
  const [storms, setStorms] = useState<StormRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ key: string; strikes: StormStrike[] } | null>(null);
  const [appendedStrikes, setAppendedStrikes] = useState<StormStrike[]>([]);
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
            const prevMap = new Map(prev.map(p => [p.stormKey, p.totalCount ?? p.count]));
            for (const row of rows) {
              const prev = prevMap.get(row.stormKey);
              if (prev != null && prev !== (row.totalCount ?? row.count))
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
    if (!expandedKey) { setDetail(null); setAppendedStrikes([]); return; }
    let cancelled = false;
    setDetail(null);
    setAppendedStrikes([]);

    const expandedStorm = storms.find(s => s.stormKey === expandedKey);
    const isLiveExpanded = expandedStorm != null && date === todayUTC()
      && expandedStorm.endTime != null && Date.now() - expandedStorm.endTime < 10 * 60_000;

    let baseCount = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    fetch(`/api/storms?key=${encodeURIComponent(expandedKey)}`)
      .then(r => r.json())
      .then((storm: { strikes: StormStrike[] | null } | null) => {
        if (cancelled || !storm?.strikes) return;
        setDetail({ key: expandedKey, strikes: storm.strikes });
        baseCount = storm.strikes.length;

        if (!isLiveExpanded) return;
        pollTimer = setInterval(async () => {
          if (cancelled || document.hidden) return;
          try {
            const res = await fetch(`/api/storms/${encodeURIComponent(expandedKey)}/strikes`);
            const data = await res.json();
            const all: StormStrike[] = data.strikes ?? [];
            if (all.length > baseCount) {
              const fresh = all.slice(baseCount);
              baseCount = all.length;
              setAppendedStrikes(prev => [...prev, ...fresh]);
            }
          } catch {}
        }, 15_000);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedKey]);

  function changeDate(next: string) {
    setDate(next);
    try { localStorage.setItem('stormLogDate', next); } catch {}
    setExpandedKey(null);
  }

  const shiftDate = (days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    const next = d.toISOString().slice(0, 10);
    if (next <= todayUTC()) changeDate(next);
  };

  const filtered = useMemo(() => {
    const now = Date.now();
    const isLiveFn = (s: StormRow) =>
      date === todayUTC() && s.endTime != null && now - s.endTime < 10 * 60 * 1000;

    const live = storms.filter(isLiveFn).sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
    const dead = storms.filter(s => !isLiveFn(s));
    return [...live, ...dead];
  }, [storms, date]);

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
            onChange={e => { if (e.target.value) changeDate(e.target.value); }}
          />
          <button className="storm-log-daybtn" onClick={() => shiftDate(1)} disabled={date >= todayUTC()} aria-label="›">›</button>
        </div>
        <span className="archive-count">{t('stormsFound', { count: filtered.length })}</span>
      </div>

      <div className="records-body">
        {!loaded ? null : filtered.length === 0 ? (
          <div className="archive-empty">{t('noStorms')}</div>
        ) : (
          <div className="hof-list">
            {filtered.map(s => {
              const open = expandedKey === s.stormKey;
              const isLive = date === todayUTC() && s.endTime != null && Date.now() - s.endTime < 10 * 60 * 1000;
              const count = s.totalCount ?? s.count;

              const isXO = s.code === 'XO';
              const effCity = s.city ?? (isXO ? 'Open Ocean' : null);
              const effOrigin = s.originCity ?? (isXO ? 'Open Ocean' : null);
              const name = effOrigin && effCity && effOrigin !== effCity
                ? ts('stormFromTo', { from: effOrigin, to: effCity })
                : effCity
                  ? ts('stormNear', { city: effCity })
                  : `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`;

              const flags = s.countryPath && s.countryPath.length > 1
                ? s.countryPath.map((cc, i) => (
                    <span key={cc} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.15rem' }}>
                      {i > 0 && <span className="hof-arrow">›</span>}
                      <CountryFlag code={cc} name={countryName(cc)} />
                    </span>
                  ))
                : (
                  <>
                    {s.originCode && s.originCode !== s.code && (
                      <>
                        <CountryFlag code={s.originCode} name={countryName(s.originCode)} />
                        <span className="hof-arrow">›</span>
                      </>
                    )}
                    <CountryFlag code={s.code} name={countryName(s.code)} />
                  </>
                );

              const mergeTag = (() => {
                const ms = mergeMap.get(s.stormKey);
                if (!ms) return null;
                let est = '';
                if (ms.type === 'merging') {
                  const rem = Math.max(0, Math.round((ms.mergeAtMs - Date.now()) / 60_000));
                  est = rem > 0 ? ` ~${rem}m` : '';
                } else if (ms.type === 'splitting' && ms.estimatedMinutes != null) {
                  est = ` ~${ms.estimatedMinutes}m`;
                }
                return (
                  <span className={`storm-merge-status-tag storm-merge-status-tag--${ms.type}`}>
                    ⚡ {ms.type}{est}
                  </span>
                );
              })();

              const rowInner = (
                <>
                  <div className="hof-main">
                    <div className="hof-name-line">
                      <span className="hof-name">{name}</span>
                      <span className="sl-badges">
                        {isLive && <span className="storm-live-tag">LIVE</span>}
                        {isLive && mergeTag}
                      </span>
                    </div>
                    <div className="hof-sub">
                      <span className="hof-flags">{flags}</span>
                      <span className="hof-sub-stats">
                        <span>{fmtRate(s.rate)}/m</span>
                        {s.startTime != null && s.endTime != null && (
                          <>
                            <span>{fmtDuration(s.endTime - s.startTime)}</span>
                            <span className="hof-sub-date">{fmtClock(s.startTime)} – {fmtClock(s.endTime)}</span>
                          </>
                        )}
                        {s.traveledKm != null && s.traveledKm >= 5 && (
                          <span>{Math.round(s.traveledKm)}km</span>
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="hof-count-wrap">
                    {s.rank != null && (
                      <span className="storm-log-rank">
                        <span className="storm-log-rank-num">#{s.rank}</span>
                        <span className="storm-log-rank-label">all-time</span>
                      </span>
                    )}
                    <span className="hof-count">{fmt(count)}</span>
                    <span className="hof-count-label">strikes</span>
                  </div>
                  {!isLive && <span className={`storm-chevron${open ? ' open' : ''}`}>▾</span>}
                </>
              );

              return (
                <div key={s.stormKey} className={`sl-item${flashKeys.has(s.stormKey) ? ' flash' : ''}`}>
                  <div className={`sl-row${isLive ? ' sl-row--live' : ''}`}>
                    {isLive
                      ? <Link href={`/storms/${encodeURIComponent(s.stormKey)}`} className="sl-head">{rowInner}</Link>
                      : (
                        <button className="sl-head" onClick={() => setExpandedKey(open ? null : s.stormKey)}>
                          {rowInner}
                        </button>
                      )}
                  </div>
                  {!isLive && open && (
                    <div className="sl-expand">
                      {detail?.key === s.stormKey
                        ? <StormReplayMap strikes={detail.strikes} />
                        : <div className="storm-log-loading">…</div>}
                    </div>
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
