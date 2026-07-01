'use client';

import { createContext, useContext, useState } from 'react';

export type HeatmapWindow = '30m' | '1h' | '3h' | '1d';

interface HeatmapContextValue {
  enabled: boolean;
  timeWindow: HeatmapWindow;
  toggle: () => void;
  setTimeWindow: (w: HeatmapWindow) => void;
}

const HeatmapContext = createContext<HeatmapContextValue>({
  enabled: false,
  timeWindow: '30m',
  toggle: () => {},
  setTimeWindow: () => {},
});

export function HeatmapProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('heatmap') === 'true';
  });
  const [timeWindow, setTimeWindowState] = useState<HeatmapWindow>(() => {
    if (typeof window === 'undefined') return '30m';
    const v = localStorage.getItem('heatmapWindow');
    if (v === '30m' || v === '1h' || v === '3h' || v === '1d') return v;
    if (v === '1w') return '1d';
    return '30m';
  });

  const toggle = () => setEnabled(v => {
    const next = !v;
    localStorage.setItem('heatmap', String(next));
    return next;
  });

  const setTimeWindow = (w: HeatmapWindow) => {
    localStorage.setItem('heatmapWindow', w);
    setTimeWindowState(w);
  };

  return (
    <HeatmapContext.Provider value={{ enabled, timeWindow, toggle, setTimeWindow }}>
      {children}
    </HeatmapContext.Provider>
  );
}

export const useHeatmap = () => useContext(HeatmapContext);
