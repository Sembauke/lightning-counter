'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../../hooks/useCountryName';
import { fmtRate, fmtClock, fmtDuration } from '../../lib/format';
import CountryFlag from '../../components/CountryFlag';
import type { BiggestStorm } from '../../lib/db';

const StormReplayMap = dynamic(() => import('../../components/StormReplayMap'), { ssr: false });

export default function StormDetailClient({ storm }: { storm: BiggestStorm }) {
  const ts = useTranslations('storms');
  const countryName = useCountryName();

  const name = storm.originCity && storm.city && storm.originCity !== storm.city
    ? ts('stormFromTo', { from: storm.originCity, to: storm.city })
    : storm.city
      ? ts('stormNear', { city: storm.city })
      : `${storm.lat.toFixed(2)}, ${storm.lon.toFixed(2)}`;

  const duration = storm.startTime != null && storm.endTime != null
    ? storm.endTime - storm.startTime : null;

  return (
    <div className="archive-page">
      <div className="archive-toolbar">
        <Link href="/records" className="storm-detail-back">← Records</Link>
      </div>

      <div className="storm-detail-body">
        <div className="storm-detail-header">
          <span className="storm-detail-country">
            {storm.countryPath && storm.countryPath.length > 1
              ? storm.countryPath.map((cc, i) => (
                  <span key={cc} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                    {i > 0 && <span className="storm-log-arrow">→</span>}
                    <CountryFlag code={cc} name={countryName(cc)} />
                    {countryName(cc)}
                  </span>
                ))
              : (<><CountryFlag code={storm.code} name={countryName(storm.code)} />{countryName(storm.code)}</>)}
          </span>
          <h1 className="storm-detail-name">{name}</h1>
          <div className="storm-detail-stats">
            <span>{ts('strikesCount', { count: storm.totalCount ?? storm.count })}</span>
            <span className="storm-detail-sep">·</span>
            <span>{ts('peakRate', { rate: fmtRate(storm.rate) })}</span>
            {duration != null && (
              <>
                <span className="storm-detail-sep">·</span>
                <span>{fmtDuration(duration)}</span>
              </>
            )}
            {storm.startTime != null && storm.endTime != null && (
              <>
                <span className="storm-detail-sep">·</span>
                <span>{fmtClock(storm.startTime)} – {fmtClock(storm.endTime)}</span>
              </>
            )}
            {storm.traveledKm != null && storm.traveledKm >= 5 && (
              <>
                <span className="storm-detail-sep">·</span>
                <span>{ts('traveled', { km: Math.round(storm.traveledKm) })}</span>
              </>
            )}
            <span className="storm-detail-sep">·</span>
            <span className="storm-detail-date">{storm.date}</span>
          </div>
        </div>

        {storm.strikes && storm.strikes.length > 0
          ? <div className="storm-detail-map"><StormReplayMap strikes={storm.strikes} /></div>
          : <div className="storm-detail-no-replay">Replay not available — strike data is kept for 7 days.</div>}
      </div>
    </div>
  );
}
