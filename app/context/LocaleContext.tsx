'use client';

import { createContext, useContext, useState, useEffect } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../../messages/en.json';
import nl from '../../messages/nl.json';
import de from '../../messages/de.json';
import fr from '../../messages/fr.json';
import es from '../../messages/es.json';

const allMessages = { en, nl, de, fr, es };
export type Locale = keyof typeof allMessages;
export const LOCALES: Locale[] = ['en', 'nl', 'de', 'fr', 'es'];

interface LocaleContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({ locale: 'en', setLocale: () => {} });
export const useLocale = () => useContext(LocaleContext);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');

  useEffect(() => {
    const stored = localStorage.getItem('locale') as Locale;
    if (stored && stored in allMessages) setLocaleState(stored);
  }, []);

  const setLocale = (l: Locale) => {
    setLocaleState(l);
    localStorage.setItem('locale', l);
  };

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <NextIntlClientProvider locale={locale} messages={allMessages[locale]} timeZone="UTC">
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  );
}
