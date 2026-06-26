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

const MAX_STRIKES = 5000;
const STRIKE_LIFETIME_MS = 30 * 60 * 1000;

export function useBlitzortung() {
  const [strikes, setStrikes] = useState<Strike[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [countryCounts, setCountryCounts] = useState<CountryCounts>({});
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const counterRef = useRef(0);

  // WebSocket for authoritative total count
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { total: number };
        if (typeof data.total === 'number') setTotalCount(data.total);
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/strikes');

    // Seed country counts from server (total comes from WebSocket)
    es.addEventListener('init', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { total: number; countries: CountryCounts };
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
      } catch { /* ignore */ }
    });

    es.addEventListener('status', (e: MessageEvent) => {
      if (e.data === 'live') {
        setConnected(true);
      } else if (e.data === 'reconnecting') {
        setConnected(false);
      }
    });

    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { lat: number; lon: number; cc?: string | null };
        const strike: Strike = {
          id: `${counterRef.current++}`,
          lat: data.lat,
          lon: data.lon,
          time: Date.now(),
          ...(data.cc ? { cc: data.cc } : {}),
        };
        setStrikes(prev => {
          const next = [strike, ...prev];
          return next.length > MAX_STRIKES ? next.slice(0, MAX_STRIKES) : next;
        });
        if (data.cc) {
          setCountryCounts(prev => ({ ...prev, [data.cc!]: (prev[data.cc!] ?? 0) + 1 }));
        }
      } catch { /* ignore */ }
    };

    es.onerror = () => setConnected(false);

    const cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - STRIKE_LIFETIME_MS;
      setStrikes(prev => prev.filter(s => s.time > cutoff));
    }, 30_000);

    return () => {
      clearInterval(cleanupInterval);
      es.close();
    };
  }, []);

  return { strikes, totalCount, countryCounts, connected, isDemo: false };
}
