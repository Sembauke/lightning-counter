'use client';

import { createContext, useContext, useState } from 'react';

interface MapSearchContextValue {
  enabled: boolean;
  toggle: () => void;
}

const MapSearchContext = createContext<MapSearchContextValue>({
  enabled: true,
  toggle: () => {},
});

export function MapSearchProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem('mapSearch');
    return saved === null ? true : saved === 'true';
  });

  const toggle = () => setEnabled(v => {
    const next = !v;
    localStorage.setItem('mapSearch', String(next));
    return next;
  });

  return (
    <MapSearchContext.Provider value={{ enabled, toggle }}>
      {children}
    </MapSearchContext.Provider>
  );
}

export const useMapSearch = () => useContext(MapSearchContext);
