'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { StormTransition } from '../lib/stormTransition';
import { collectStormTransitions, STORM_TRANSITION_STALE_MS } from '../lib/stormTransitionDisplay';
import type { StormLiveRateSnapshot } from '../lib/stormLiveRate';

type StormMergeContextValue = {
  mergeMap: Map<string, StormTransition>;
  now: number;
  connected: boolean;
  liveRateSnapshot: StormLiveRateSnapshot | null;
};

const StormMergeContext = createContext<StormMergeContextValue>({
  mergeMap: new Map(),
  now: 0,
  connected: false,
  liveRateSnapshot: null,
});

export function StormMergeProvider({ children }: { children: ReactNode }) {
  const [mergeMap, setMergeMap] = useState<Map<string, StormTransition>>(new Map());
  // Start with the same clock during SSR and hydration; stream events/ticks
  // establish the browser clock after mount.
  const [now, setNow] = useState(0);
  const [sourceLive, setSourceLive] = useState(false);
  const [lastSnapshotAt, setLastSnapshotAt] = useState(0);
  const [liveRateSnapshot, setLiveRateSnapshot] = useState<StormLiveRateSnapshot | null>(null);

  // This global provider also runs on direct storm list/detail navigation.
  // Only a server snapshot can cancel or confirm transitions. A disconnected
  // stream leaves the last pending state visible with a waiting label.
  useEffect(() => {
    const source = new EventSource('/api/strikes');
    source.addEventListener('storms', (event: MessageEvent) => {
      try {
        const transitions = collectStormTransitions(JSON.parse(event.data));
        if (!transitions) return;
        const receivedAt = Date.now();
        setMergeMap(transitions);
        setLastSnapshotAt(receivedAt);
        setNow(receivedAt);
      } catch { /* Preserve the last valid snapshot until the server replaces it. */ }
    });
    source.addEventListener('storm-rates', (event: MessageEvent) => {
      try {
        const snapshot = JSON.parse(event.data) as StormLiveRateSnapshot;
        if (!snapshot || !Number.isFinite(snapshot.at) || !snapshot.rates
          || typeof snapshot.rates !== 'object' || Array.isArray(snapshot.rates)
          || Object.values(snapshot.rates).some(rate => rate !== null && (!Number.isInteger(rate) || rate < 0))) return;
        if (snapshot.peakRates !== undefined && (!snapshot.peakRates
          || typeof snapshot.peakRates !== 'object' || Array.isArray(snapshot.peakRates)
          || Object.values(snapshot.peakRates).some(rate => rate !== null && (!Number.isFinite(rate) || rate < 0)))) return;
        setLiveRateSnapshot(previous => previous && previous.at > snapshot.at ? previous : snapshot);
        setNow(Date.now());
      } catch { /* Keep the last valid rates; the shared clock will expire stale data. */ }
    });
    source.addEventListener('status', (event: MessageEvent) => {
      setSourceLive(event.data === 'live');
      setNow(Date.now());
    });
    source.onerror = () => { setSourceLive(false); setNow(Date.now()); };
    return () => source.close();
  }, []);

  // Run before the first rate event too, so an SSR fallback cannot remain live
  // indefinitely if the stream never connects.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const connected = sourceLive && now - lastSnapshotAt <= STORM_TRANSITION_STALE_MS;
  return (
    <StormMergeContext.Provider value={{ mergeMap, now, connected, liveRateSnapshot }}>
      {children}
    </StormMergeContext.Provider>
  );
}

export function useStormMerge() {
  return useContext(StormMergeContext);
}
