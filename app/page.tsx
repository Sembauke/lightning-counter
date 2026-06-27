'use client';

import dynamic from 'next/dynamic';
import { useBlitzortung } from './hooks/useBlitzortung';

const LightningMap = dynamic(() => import('./components/LightningMap'), {
  ssr: false,
  loading: () => <div className="map-loading">Loading map…</div>,
});

export default function Home() {
  const { strikes } = useBlitzortung();

  return (
    <main className="app">
      <div className="map-container">
        <LightningMap strikes={strikes} />
      </div>
      <div className="attribution">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>{' '}
        © <a href="https://carto.com/" target="_blank" rel="noreferrer">CARTO</a>
        {' · Blitzortung.org'}
      </div>
    </main>
  );
}
