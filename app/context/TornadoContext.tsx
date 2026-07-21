'use client';

import { createContext, useContext, useState } from 'react';

interface TornadoContextValue {
  enabled: boolean;
  toggle: () => void;
}

const TornadoContext = createContext<TornadoContextValue>({
  enabled: false,
  toggle: () => {},
});

export function TornadoProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('tornadoWarnings') === 'true';
  });

  const toggle = () => setEnabled(v => {
    const next = !v;
    localStorage.setItem('tornadoWarnings', String(next));
    return next;
  });

  return (
    <TornadoContext.Provider value={{ enabled, toggle }}>
      {children}
    </TornadoContext.Provider>
  );
}

export const useTornado = () => useContext(TornadoContext);
