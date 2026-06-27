'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import CountUp from 'react-countup';
import { useSatellite } from '../context/SatelliteContext';
import { useSound } from '../context/SoundContext';

function useNavCount() {
  const [display, setDisplay] = useState(0);
  const [connected, setConnected] = useState(false);
  const targetRef = useRef(0);
  const seededRef = useRef(false);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (typeof d.total === 'number') {
          targetRef.current = d.total;
          if (!seededRef.current) {
            seededRef.current = true;
            setDisplay(d.total); // jump to real value on first message
          }
        }
      } catch { /* ignore */ }
    };
    ws.onopen  = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    return () => ws.close();
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setDisplay(prev => {
        const target = targetRef.current;
        if (prev >= target) return prev;
        const delta = target - prev;
        // catch up faster when far behind, tick by 1 when close
        return prev + (delta > 50 ? Math.ceil(delta / 20) : 1);
      });
    }, 100);
    return () => clearInterval(id);
  }, []);

  return { display, connected };
}

function StrikeCount({ display }: { display: number; connected: boolean }) {
  return (
    <>
      <span className="navbar-count-num">
        <CountUp preserveValue end={display} separator="," duration={0.1} />
      </span>
      <span className="navbar-count-label">strikes</span>
    </>
  );
}

export default function Navbar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const { display, connected } = useNavCount();
  const { satellite, toggle: toggleSatellite } = useSatellite();
  const { sound, toggle: toggleSound } = useSound();

  const tabs = [
    { href: '/',          label: 'Strike Map' },
    { href: '/countries', label: 'By Country' },
    { href: '/stats',     label: 'Archive' },
  ];

  return (
    <>
      <nav className="navbar">
        <div className="navbar-brand">
          <span className="site-icon">⚡</span>
          <span className="site-title">Lightning Stats</span>
        </div>

        {/* Desktop tabs */}
        <div className="navbar-tabs">
          {tabs.map(t => (
            <Link key={t.href} href={t.href} className={`nav-tab${path === t.href ? ' active' : ''}`}>
              {t.label}
            </Link>
          ))}
        </div>

        {/* Satellite toggle */}
        <label className="satellite-switch" aria-label="Toggle satellite view">
          <input type="checkbox" checked={satellite} onChange={toggleSatellite} />
          <span className="satellite-track">
            <span className="satellite-thumb" />
          </span>
          <span className="satellite-label">Satellite</span>
        </label>

        {/* Sound toggle */}
        <label className="satellite-switch" aria-label="Toggle strike sounds">
          <input type="checkbox" checked={sound} onChange={toggleSound} />
          <span className="satellite-track">
            <span className="satellite-thumb" />
          </span>
          <span className="satellite-label">Sound</span>
        </label>

        {/* Desktop count — right side */}
        <div className="navbar-count">
          <StrikeCount display={display} connected={connected} />
        </div>

        {/* Mobile hamburger */}
        <button
          className="navbar-menu-btn"
          onClick={() => setOpen(o => !o)}
          aria-label="Toggle navigation"
          aria-expanded={open}
        >
          {open ? '✕' : '☰'}
        </button>
      </nav>

      {/* Mobile dropdown — sits below the stats bar */}
      <div className={`navbar-dropdown${open ? ' open' : ''}`} onClick={() => setOpen(false)}>
        {tabs.map(t => (
          <Link key={t.href} href={t.href} className={`nav-tab${path === t.href ? ' active' : ''}`}>
            {t.label}
          </Link>
        ))}
      </div>

      {/* Mobile stats bar — fixed below navbar, same styling */}
      <div className="navbar-stats-bar">
        <StrikeCount display={display} connected={connected} />
      </div>
    </>
  );
}
