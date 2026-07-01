'use client';

import { createContext, useContext, useState } from 'react';

interface WindContextValue {
  enabled: boolean;
  toggle: () => void;
}

const WindContext = createContext<WindContextValue>({ enabled: false, toggle: () => {} });

export function WindProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(() =>
    typeof window !== 'undefined' && localStorage.getItem('windEnabled') === 'true'
  );
  const toggle = () => setEnabled(v => {
    const next = !v;
    localStorage.setItem('windEnabled', String(next));
    return next;
  });
  return <WindContext.Provider value={{ enabled, toggle }}>{children}</WindContext.Provider>;
}

export const useWind = () => useContext(WindContext);
