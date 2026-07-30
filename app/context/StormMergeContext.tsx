'use client';
import { createContext, useContext, useRef, useState, useCallback, ReactNode } from 'react';

export type MergeStatus = {
  type: 'merging';
  withStormKeys: string[];
  mergeAtMs: number; // absolute timestamp of predicted hull contact
} | {
  type: 'splitting';
  estimatedMinutes: number | null;
} | null;

// stormKey → MergeStatus
type MergeMap = Map<string, MergeStatus>;

type StormMergeContextValue = {
  mergeMap: MergeMap;
  updateMergeStatus: (map: MergeMap) => void;
};

const StormMergeContext = createContext<StormMergeContextValue>({
  mergeMap: new Map(),
  updateMergeStatus: () => {},
});

export function StormMergeProvider({ children }: { children: ReactNode }) {
  const [mergeMap, setMergeMap] = useState<MergeMap>(new Map());
  const updateMergeStatus = useCallback((map: MergeMap) => setMergeMap(map), []);
  return (
    <StormMergeContext.Provider value={{ mergeMap, updateMergeStatus }}>
      {children}
    </StormMergeContext.Provider>
  );
}

export function useStormMerge() {
  return useContext(StormMergeContext);
}
