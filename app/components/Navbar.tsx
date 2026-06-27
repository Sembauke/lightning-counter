'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

export default function Navbar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <span className="site-icon">⚡</span>
        <span className="site-title">Lightning Stats</span>
      </div>

      <button
        className="navbar-menu-btn"
        onClick={() => setOpen(o => !o)}
        aria-label="Toggle navigation"
        aria-expanded={open}
      >
        {open ? '✕' : '☰'}
      </button>

      <div className={`navbar-tabs${open ? ' open' : ''}`} onClick={() => setOpen(false)}>
        <Link href="/" className={`nav-tab${path === '/' ? ' active' : ''}`}>
          Strike Map
        </Link>
        <Link href="/countries" className={`nav-tab${path === '/countries' ? ' active' : ''}`}>
          By Country
        </Link>
        <Link href="/stats" className={`nav-tab${path === '/stats' ? ' active' : ''}`}>
          Archive
        </Link>
      </div>
    </nav>
  );
}
