'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function Navbar() {
  const path = usePathname();

  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <span className="site-icon">⚡</span>
        <span className="site-title">Lightning Counter</span>
      </div>
      <div className="navbar-tabs">
        <Link href="/" className={`nav-tab${path === '/' ? ' active' : ''}`}>
          Strike Map
        </Link>
        <Link href="/countries" className={`nav-tab${path === '/countries' ? ' active' : ''}`}>
          Strikes per Country
        </Link>
        <Link href="/stats" className={`nav-tab${path === '/stats' ? ' active' : ''}`}>
          Strike Archive
        </Link>
      </div>
    </nav>
  );
}
