'use client';

import { createContext, useContext, useState } from 'react';

interface ReplayContextValue {
  extend24h: boolean;
  toggle: () => void;
}

const ReplayContext = createContext<ReplayContextValue>({ extend24h: false, toggle: () => {} });

export function ReplayProvider({ children }: { children: React.ReactNode }) {
  const [extend24h, setExtend24h] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('replay24h') === 'true';
  });

  const toggle = () => setExtend24h(v => {
    const next = !v;
    localStorage.setItem('replay24h', String(next));
    return next;
  });

  return (
    <ReplayContext.Provider value={{ extend24h, toggle }}>
      {children}
    </ReplayContext.Provider>
  );
}

export const useReplay = () => useContext(ReplayContext);
