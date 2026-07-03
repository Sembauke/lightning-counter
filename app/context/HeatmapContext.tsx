'use client';

import { createContext, useContext, useState } from 'react';

interface HeatmapContextValue {
  enabled: boolean;
  toggle: () => void;
}

const HeatmapContext = createContext<HeatmapContextValue>({
  enabled: false,
  toggle: () => {},
});

export function HeatmapProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('heatmap') === 'true';
  });

  const toggle = () => setEnabled(v => {
    const next = !v;
    localStorage.setItem('heatmap', String(next));
    return next;
  });

  return (
    <HeatmapContext.Provider value={{ enabled, toggle }}>
      {children}
    </HeatmapContext.Provider>
  );
}

export const useHeatmap = () => useContext(HeatmapContext);
