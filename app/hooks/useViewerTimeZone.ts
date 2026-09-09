'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};
const serverTimeZone = () => 'UTC';
const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Match the server during hydration, then display the viewer's local clock. */
export function useViewerTimeZone(): string {
  return useSyncExternalStore(subscribe, viewerTimeZone, serverTimeZone);
}
