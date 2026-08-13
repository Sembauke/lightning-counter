'use client';

import { createContext, useContext, useState } from 'react';

interface TooltipContextValue {
  enabled: boolean;
  toggle: () => void;
}

const TooltipContext = createContext<TooltipContextValue>({
  enabled: false,
  toggle: () => {},
});

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    const saved = localStorage.getItem('countryTooltip');
    return saved === null ? false : saved === 'true';
  });

  const toggle = () => setEnabled(v => {
    const next = !v;
    localStorage.setItem('countryTooltip', String(next));
    return next;
  });

  return (
    <TooltipContext.Provider value={{ enabled, toggle }}>
      {children}
    </TooltipContext.Provider>
  );
}

export const useCountryTooltip = () => useContext(TooltipContext);
