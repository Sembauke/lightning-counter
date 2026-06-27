'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import CountUp from 'react-countup';
import { useSatellite } from '../context/SatelliteContext';

function useNavCount() {
  const [total, setTotal] = useState(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (typeof d.total === 'number') setTotal(d.total);
      } catch { /* ignore */ }
    };
    ws.onopen  = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    return () => ws.close();
  }, []);

  return { total, connected };
}

function StrikeCount({ total }: { total: number; connected: boolean }) {
  return (
    <>
      <span className="navbar-count-num">
        <CountUp preserveValue end={total} separator="," />
      </span>
      <span className="navbar-count-label">strikes</span>
    </>
  );
}

export default function Navbar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const { total, connected } = useNavCount();
  const { satellite, toggle: toggleSatellite } = useSatellite();

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
        <button
          className={`satellite-btn${satellite ? ' active' : ''}`}
          onClick={toggleSatellite}
          aria-label="Toggle satellite view"
        >
          🛰 Satellite
        </button>

        {/* Desktop count — right side */}
        <div className="navbar-count">
          <StrikeCount total={total} connected={connected} />
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
        <StrikeCount total={total} connected={connected} />
      </div>
    </>
  );
}
