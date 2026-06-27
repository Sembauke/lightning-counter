'use client';

import { createContext, useContext, useState } from 'react';

interface SatelliteContextValue {
  satellite: boolean;
  toggle: () => void;
}

const SatelliteContext = createContext<SatelliteContextValue>({
  satellite: false,
  toggle: () => {},
});

export function SatelliteProvider({ children }: { children: React.ReactNode }) {
  const [satellite, setSatellite] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('satellite') === 'true';
  });

  const toggle = () => setSatellite(v => {
    const next = !v;
    localStorage.setItem('satellite', String(next));
    return next;
  });

  return (
    <SatelliteContext.Provider value={{ satellite, toggle }}>
      {children}
    </SatelliteContext.Provider>
  );
}

export function useSatellite() {
  return useContext(SatelliteContext);
}
