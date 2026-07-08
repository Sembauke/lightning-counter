'use client';

import { useState, useEffect, useRef } from 'react';

export interface Strike {
  id: string;
  lat: number;
  lon: number;
  time: number;
  cc?: string;
}

export type CountryCounts = Record<string, number>;

// Must hold at least the storm widget's full 5-min window at peak rates (~100/s)
const MAX_STRIKES = 40000;
const STRIKE_LIFETIME_MS = 30 * 60 * 1000;
// Strikes can arrive at 30–100/sec globally — batching keeps React renders at ~1/sec
const FLUSH_INTERVAL_MS = 800;

export function useBlitzortung() {
  const [strikes, setStrikes] = useState<Strike[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [countryCounts, setCountryCounts] = useState<CountryCounts>({});
  const [connected, setConnected] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const counterRef = useRef(0);

  useEffect(() => {
    const es = new EventSource('/api/strikes');

    es.addEventListener('init', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { total: number; countries: CountryCounts };
        setTotalCount(data.total);
        setCountryCounts(data.countries);
      } catch { /* ignore */ }
    });

    // Pre-populate map with strikes from the last 30 min
    es.addEventListener('history', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as Array<{ lat: number; lon: number; cc?: string | null; time: number }>;
        const historical: Strike[] = data.map(s => ({
          id: `hist-${counterRef.current++}`,
          lat: s.lat,
          lon: s.lon,
          time: s.time,
          ...(s.cc ? { cc: s.cc } : {}),
        }));
        setStrikes(historical);
        setHistoryLoaded(true);
      } catch { /* ignore */ }
    });

    es.addEventListener('status', (e: MessageEvent) => {
      if (e.data === 'live') {
        setConnected(true);
      } else if (e.data === 'reconnecting') {
        setConnected(false);
      }
    });

    let pendingStrikes: Strike[] = [];
    let pendingCounts: CountryCounts = {};
    let pendingCountsDirty = false;

    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { lat: number; lon: number; cc?: string | null };
        pendingStrikes.push({
          id: `${counterRef.current++}`,
          lat: data.lat,
          lon: data.lon,
          time: Date.now(),
          ...(data.cc ? { cc: data.cc } : {}),
        });
        if (data.cc) {
          pendingCounts[data.cc] = (pendingCounts[data.cc] ?? 0) + 1;
          pendingCountsDirty = true;
        }
      } catch { /* ignore */ }
    };

    const flushInterval = setInterval(() => {
      if (pendingStrikes.length > 0) {
        const batch = pendingStrikes.reverse(); // newest first, matching list order
        pendingStrikes = [];
        setStrikes(prev => {
          const next = [...batch, ...prev];
          return next.length > MAX_STRIKES ? next.slice(0, MAX_STRIKES) : next;
        });
      }
      if (pendingCountsDirty) {
        const counts = pendingCounts;
        pendingCounts = {};
        pendingCountsDirty = false;
        setCountryCounts(prev => {
          const next = { ...prev };
          for (const cc in counts) next[cc] = (next[cc] ?? 0) + counts[cc];
          return next;
        });
      }
    }, FLUSH_INTERVAL_MS);

    es.onerror = () => setConnected(false);

    const cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - STRIKE_LIFETIME_MS;
      setStrikes(prev => prev.filter(s => s.time > cutoff));
    }, 30_000);

    return () => {
      clearInterval(flushInterval);
      clearInterval(cleanupInterval);
      es.close();
    };
  }, []);

  return { strikes, totalCount, countryCounts, connected, historyLoaded, isDemo: false };
}
