'use client';

import { createContext, useContext, useState } from 'react';

interface StormRanksContextValue {
  enabled: boolean;
  toggle: () => void;
}

const StormRanksContext = createContext<StormRanksContextValue>({
  enabled: true,
  toggle: () => {},
});

export function StormRanksProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem('stormRanks');
    return saved === null ? true : saved === 'true';
  });

  const toggle = () => setEnabled(v => {
    const next = !v;
    localStorage.setItem('stormRanks', String(next));
    return next;
  });

  return (
    <StormRanksContext.Provider value={{ enabled, toggle }}>
      {children}
    </StormRanksContext.Provider>
  );
}

export const useStormRanks = () => useContext(StormRanksContext);
