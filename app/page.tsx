'use client';

import dynamic from 'next/dynamic';
import { useBlitzortung } from './hooks/useBlitzortung';
import StrikeCounter from './components/StrikeCounter';
import ColorLegend from './components/ColorLegend';

const LightningMap = dynamic(() => import('./components/LightningMap'), {
  ssr: false,
  loading: () => <div className="map-loading">Loading map…</div>,
});

export default function Home() {
  const { strikes, totalCount, connected } = useBlitzortung();

  return (
    <main className="app">
      <div className="map-container">
        <LightningMap strikes={strikes} />
      </div>

      {/* Bottom panel: legend + counter stacked */}
      <div className="bottom-panel">
        <ColorLegend />
        <StrikeCounter
          totalCount={totalCount}
          connected={connected}
        />
      </div>

      <div className="attribution">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>{' '}
        © <a href="https://carto.com/" target="_blank" rel="noreferrer">CARTO</a>
        {' · Blitzortung.org'}
      </div>
    </main>
  );
}
