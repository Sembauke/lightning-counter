import type { Metadata } from 'next';
import './globals.css';
import Navbar from './components/Navbar';
import { SatelliteProvider } from './context/SatelliteContext';
import { SoundProvider } from './context/SoundContext';

export const metadata: Metadata = {
  title: 'Lightning Stats',
  description: 'Real-time global lightning strike tracker'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        <SatelliteProvider>
          <SoundProvider>
            <Navbar />
            {children}
          </SoundProvider>
        </SatelliteProvider>
      </body>
    </html>
  );
}
