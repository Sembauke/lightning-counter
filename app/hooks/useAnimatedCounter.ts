'use client';

import { useState, useEffect, useRef } from 'react';

export function useAnimatedCounter(target: number, duration = 400): number {
  const [displayed, setDisplayed] = useState(target);
  const fromRef = useRef(target);
  const startTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target === displayed) return;

    fromRef.current = displayed;
    startTimeRef.current = null;

    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const animate = (ts: number) => {
      if (!startTimeRef.current) startTimeRef.current = ts;
      const elapsed = ts - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayed(Math.round(fromRef.current + (target - fromRef.current) * eased));
      if (progress < 1) rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, duration]);

  return displayed;
}

export function useStrikeRate(totalCount: number, windowMs = 60_000): number {
  const historyRef = useRef<number[]>([]);
  const [rate, setRate] = useState(0);

  useEffect(() => {
    const now = Date.now();
    historyRef.current.push(now);

    // Prune entries older than the window
    const cutoff = now - windowMs;
    historyRef.current = historyRef.current.filter(t => t > cutoff);

    setRate(historyRef.current.length);
  }, [totalCount, windowMs]);

  return rate;
}
