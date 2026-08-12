'use client';
import { useEffect, useState } from 'react';
import { fmtClock } from '../lib/format';
import type { StormEvent } from '../lib/db';

const INFLATED_THRESHOLD = 100_000;

interface Props {
  stormKey: string;
  isLive: boolean;
  stormTotal?: number;
}

export default function StormEventsWidget({ stormKey, isLive, stormTotal }: Props) {
  const [events, setEvents] = useState<StormEvent[]>([]);

  useEffect(() => {
    const fetchEvents = async () => {
      try {
        const res = await fetch(`/api/storms/${encodeURIComponent(stormKey)}/events`);
        if (res.ok) setEvents(await res.json() as StormEvent[]);
      } catch { /* network blip */ }
    };
    fetchEvents();
    if (!isLive) return;
    const id = setInterval(fetchEvents, 60_000);
    return () => clearInterval(id);
  }, [stormKey, isLive]);

  if (events.length === 0) return null;


  return (
    <div className="storm-section">
      <details className="storm-events-details" open>
        <summary className="storm-section-title storm-events-summary">
          Storm events
          <span className="storm-events-chevron">›</span>
        </summary>
        <div className="storm-events-log">
          {events.map(ev => {
            const isMerge = ev.eventType === 'merge';
            const strikes = ev.strikesAbsorbed;
            // Hide counts that are logically impossible (exceed storm's entire
            // lifetime total) or clearly a restart artifact (absolute cap).
            const showCount = isMerge
              && strikes != null
              && strikes > 0
              && strikes < INFLATED_THRESHOLD
              && (stormTotal == null || strikes < stormTotal);
            return (
              <div key={ev.id} className={`storm-event-row storm-event-row--${ev.eventType}`}>
                <span className="storm-event-time">{fmtClock(ev.ts)}</span>
                <span className="storm-event-icon" aria-hidden="true">
                  {isMerge ? '⚡' : '⇢'}
                </span>
                <span className="storm-event-label">
                  {isMerge ? 'Absorbed' : 'Split off'}
                  {ev.relatedCity ? ` · ${ev.relatedCity}` : ''}
                </span>
                {showCount
                  ? <span className="storm-event-count">+{strikes!.toLocaleString()}</span>
                  : <span />}
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}
