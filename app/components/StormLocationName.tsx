'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatStormName, type StormLocation } from '../lib/stormLocation';

/** Full province/state labels, with a measured city-only fallback on mobile. */
export default function StormLocationName({ storm, prefix = '' }: { storm: StormLocation; prefix?: string }) {
  const t = useTranslations('storms');
  const compact = prefix + formatStormName(storm, t);
  const detailed = prefix + formatStormName(storm, t, true);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [useCompact, setUseCompact] = useState(true);

  useEffect(() => {
    const probe = probeRef.current;
    if (!probe || compact === detailed) return;
    const mobile = window.matchMedia('(max-width: 640px)');
    const measure = () => setUseCompact(mobile.matches && probe.scrollWidth > probe.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    mobile.addEventListener('change', measure);
    void document.fonts.ready.then(measure);
    return () => {
      observer.disconnect();
      mobile.removeEventListener('change', measure);
    };
  }, [compact, detailed]);

  return (
    <span className="storm-location" data-compact={useCompact} title={detailed}>
      <span className="storm-location-detailed">{detailed}</span>
      <span className="storm-location-compact">{compact}</span>
      {compact !== detailed && <span ref={probeRef} className="storm-location-probe" aria-hidden="true">{detailed}</span>}
    </span>
  );
}
