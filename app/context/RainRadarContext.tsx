'use client';

import { createContext, useContext, useState } from 'react';

interface RainRadarContextValue {
  enabled: boolean;
  toggle: () => void;
}

const RainRadarContext = createContext<RainRadarContextValue>({
  enabled: false,
  toggle: () => {},
});

export function RainRadarProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('rainRadar') === 'true';
  });

  const toggle = () => setEnabled(v => {
    const next = !v;
    localStorage.setItem('rainRadar', String(next));
    return next;
  });

  return (
    <RainRadarContext.Provider value={{ enabled, toggle }}>
      {children}
    </RainRadarContext.Provider>
  );
}

export const useRainRadar = () => useContext(RainRadarContext);
