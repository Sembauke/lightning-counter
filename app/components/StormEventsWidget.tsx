'use client';
import { useEffect, useState } from 'react';
import { fmtClock } from '../lib/format';
import type { StormEvent } from '../lib/db';

interface Props {
  stormKey: string;
  isLive: boolean;
}

export default function StormEventsWidget({ stormKey, isLive }: Props) {
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
      <div className="storm-section-title">Storm events</div>
      <div className="storm-events-log">
        {events.map(ev => (
          <div key={ev.id} className={`storm-event-row storm-event-row--${ev.eventType}`}>
            <span className="storm-event-icon" aria-hidden="true">
              {ev.eventType === 'merge' ? '⚡' : '⇢'}
            </span>
            <div className="storm-event-body">
              <span className="storm-event-label">
                {ev.eventType === 'merge' ? 'Absorbed' : 'Split off'}
                {ev.relatedCity ? ` · ${ev.relatedCity}` : ''}
                {ev.strikesAbsorbed != null && ev.strikesAbsorbed > 0
                  ? ` (+${ev.strikesAbsorbed.toLocaleString()} strikes)`
                  : null}
              </span>
              <span className="storm-event-time">{fmtClock(ev.ts)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
