'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { StormTransition } from '../lib/stormTransition';
import { collectStormTransitions, STORM_TRANSITION_STALE_MS } from '../lib/stormTransitionDisplay';

type StormMergeContextValue = {
  mergeMap: Map<string, StormTransition>;
  now: number;
  connected: boolean;
};

const StormMergeContext = createContext<StormMergeContextValue>({
  mergeMap: new Map(),
  now: 0,
  connected: false,
});

export function StormMergeProvider({ children }: { children: ReactNode }) {
  const [mergeMap, setMergeMap] = useState<Map<string, StormTransition>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const [sourceLive, setSourceLive] = useState(false);
  const [lastSnapshotAt, setLastSnapshotAt] = useState(0);

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
    source.addEventListener('status', (event: MessageEvent) => {
      setSourceLive(event.data === 'live');
      setNow(Date.now());
    });
    source.onerror = () => { setSourceLive(false); setNow(Date.now()); };
    return () => source.close();
  }, []);

  const hasPending = mergeMap.size > 0;
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasPending]);

  const connected = sourceLive && now - lastSnapshotAt <= STORM_TRANSITION_STALE_MS;
  return (
    <StormMergeContext.Provider value={{ mergeMap, now, connected }}>
      {children}
    </StormMergeContext.Provider>
  );
}

export function useStormMerge() {
  return useContext(StormMergeContext);
}
