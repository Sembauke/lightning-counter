'use client';

import { createContext, useContext, useState } from 'react';

interface TooltipContextValue {
  enabled: boolean;
  toggle: () => void;
}

const TooltipContext = createContext<TooltipContextValue>({
  enabled: true,
  toggle: () => {},
});

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  // On by default — only an explicit opt-out disables it
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem('countryTooltip') !== 'false';
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
