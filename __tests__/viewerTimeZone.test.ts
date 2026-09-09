import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useViewerTimeZone } from '../app/hooks/useViewerTimeZone';
import { fmtClock } from '../app/lib/format';

const time = Date.parse('2026-09-09T07:42:12Z');
function Clock() {
  return React.createElement('span', null, fmtClock(time, false, useViewerTimeZone()));
}

afterEach(() => vi.unstubAllEnvs());

describe('hydration-safe storm clocks', () => {
  it.each(['UTC', 'Europe/Amsterdam', 'America/New_York', 'Asia/Kolkata'])(
    'uses the same UTC server snapshot when the server runs in %s', zone => {
      vi.stubEnv('TZ', zone);
      expect(renderToStaticMarkup(React.createElement(Clock))).toBe('<span>07:42</span>');
    },
  );

  it('formats the viewer clock after hydration, including seconds and midnight', () => {
    expect(fmtClock(time, true, 'Europe/Amsterdam')).toBe('09:42:12');
    expect(fmtClock(time, false, 'America/New_York')).toBe('03:42');
    expect(fmtClock(Date.parse('2026-09-09T23:30:00Z'), false, 'Asia/Kolkata')).toBe('05:00');
  });

  it('uses the viewer timezone offset at the strike time across daylight saving changes', () => {
    expect(fmtClock(Date.parse('2026-03-29T00:30:00Z'), false, 'Europe/Amsterdam')).toBe('01:30');
    expect(fmtClock(Date.parse('2026-03-29T01:30:00Z'), false, 'Europe/Amsterdam')).toBe('03:30');
  });
});
