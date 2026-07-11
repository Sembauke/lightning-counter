'use client';

import { useMemo } from 'react';
import { useLocale } from '../context/LocaleContext';

/** Localized country name from an ISO alpha-2 code, falling back to the code */
export function useCountryName(): (code: string) => string {
  const { locale } = useLocale();

  const displayNames = useMemo(() => {
    if (typeof Intl === 'undefined') return null;
    try { return new Intl.DisplayNames([locale], { type: 'region' }); } catch { return null; }
  }, [locale]);

  return (code: string) => {
    try { return displayNames?.of(code) ?? code; } catch { return code; }
  };
}
