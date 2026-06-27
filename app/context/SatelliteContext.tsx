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
  const [satellite, setSatellite] = useState(false);
  return (
    <SatelliteContext.Provider value={{ satellite, toggle: () => setSatellite(v => !v) }}>
      {children}
    </SatelliteContext.Provider>
  );
}

export function useSatellite() {
  return useContext(SatelliteContext);
}
