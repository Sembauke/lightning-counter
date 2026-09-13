import { useLocale, useTranslations } from 'next-intl';
import { fmtClock, fmtDuration } from '../lib/format';
import type { StormLogRow } from '../lib/db';

export default function StormMetrics({ storm, showDate = false }: { storm: StormLogRow; showDate?: boolean }) {
  const t = useTranslations('stormMetrics');
  const locale = useLocale();
  const hasDuration = storm.startTime != null && storm.endTime != null;
  const rate = storm.rate.toLocaleString(locale, {
    minimumFractionDigits: storm.rate < 10 ? 1 : 0,
    maximumFractionDigits: storm.rate < 10 ? 1 : 0,
  });

  return (
    <span className="hof-sub-stats">
      <span className="hof-stat">
        <span className="hof-stat-label">{t('peakRate')}</span>
        <span className="hof-stat-value">{rate}<span className="hof-stat-unit"> {t('perMinute')}</span></span>
      </span>
      <span className="hof-stat">
        <span className="hof-stat-label">{t('duration')}</span>
        <span className="hof-stat-value">{hasDuration ? fmtDuration(storm.endTime! - storm.startTime!) : '—'}</span>
      </span>
      <span className="hof-stat">
        <span className="hof-stat-label">{t('distance')}</span>
        <span className="hof-stat-value">
          {storm.traveledKm != null && storm.traveledKm >= 5
            ? <>{Math.round(storm.traveledKm).toLocaleString(locale)}<span className="hof-stat-unit"> km</span></>
            : '—'}
        </span>
      </span>
      {showDate ? (
        <span className="hof-stat">
          <span className="hof-stat-label">{t('date')}</span>
          <time className="hof-stat-value" dateTime={storm.date}>
            {new Date(`${storm.date}T00:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}
          </time>
        </span>
      ) : hasDuration && (
        <span className="hof-stat">
          <span className="hof-stat-label">{t('time')}</span>
          <span className="hof-stat-value">{fmtClock(storm.startTime!)} – {fmtClock(storm.endTime!)}</span>
        </span>
      )}
    </span>
  );
}
