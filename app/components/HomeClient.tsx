'use client';

import dynamic from 'next/dynamic';
import { useBlitzortung } from '../hooks/useBlitzortung';
import { useSatellite } from '../context/SatelliteContext';
import { useSound } from '../context/SoundContext';

const LightningMap = dynamic(() => import('./LightningMap'), {
  ssr: false,
  loading: () => <div className="map-loading">Loading map…</div>,
});

export default function HomeClient() {
  const { strikes, historyLoaded } = useBlitzortung();
  const { satellite } = useSatellite();
  const { sound } = useSound();

  return (
    <main className="app">
      <div className="map-container">
        <LightningMap strikes={strikes} satellite={satellite} sound={sound} historyLoaded={historyLoaded} />
      </div>
      <div className="attribution">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>{' '}
        © <a href="https://carto.com/" target="_blank" rel="noreferrer">CARTO</a>
        {' · Blitzortung.org · ESRI'}
      </div>
    </main>
  );
}
