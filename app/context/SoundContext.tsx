'use client';

import { createContext, useContext, useState } from 'react';

interface SoundContextValue {
  sound: boolean;
  toggle: () => void;
}

const SoundContext = createContext<SoundContextValue>({ sound: false, toggle: () => {} });

export function SoundProvider({ children }: { children: React.ReactNode }) {
  const [sound, setSound] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('sound') === 'true';
  });

  const toggle = () => setSound(v => {
    const next = !v;
    localStorage.setItem('sound', String(next));
    return next;
  });

  return <SoundContext.Provider value={{ sound, toggle }}>{children}</SoundContext.Provider>;
}

export function useSound() {
  return useContext(SoundContext);
}
