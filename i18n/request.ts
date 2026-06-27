import { getRequestConfig } from 'next-intl/server';

// Server-side default: English. The client-side LocaleProvider
// takes over after hydration and applies the user's stored locale.
export default getRequestConfig(async () => {
  return {
    locale: 'en',
    messages: (await import('../messages/en.json')).default,
    timeZone: 'UTC',
  };
});
