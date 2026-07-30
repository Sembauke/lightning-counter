'use client';

import { createContext, useContext, useState } from 'react';

interface StormOutlineContextValue {
  enabled: boolean;
  toggle: () => void;
}

const StormOutlineContext = createContext<StormOutlineContextValue>({
  enabled: false,
  toggle: () => {},
});

export function StormOutlineProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('stormOutline') === 'true';
  });

  const toggle = () => setEnabled(v => {
    const next = !v;
    localStorage.setItem('stormOutline', String(next));
    return next;
  });

  return (
    <StormOutlineContext.Provider value={{ enabled, toggle }}>
      {children}
    </StormOutlineContext.Provider>
  );
}

export const useStormOutline = () => useContext(StormOutlineContext);
