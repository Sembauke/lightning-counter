'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import CountUp from 'react-countup';
import { useTranslations } from 'next-intl';
import { useSatellite } from '../context/SatelliteContext';
import { useSound } from '../context/SoundContext';
import { useLocale, LOCALES, type Locale } from '../context/LocaleContext';

const LOCALE_FLAGS: Record<Locale, string> = { en: 'gb', nl: 'nl', de: 'de', fr: 'fr', es: 'es' };

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
            setDisplay(d.total);
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
        return prev + (delta > 50 ? Math.ceil(delta / 20) : 1);
      });
    }, 100);
    return () => clearInterval(id);
  }, []);

  return { display, connected };
}

function StrikeCount({ display, t }: { display: number; connected: boolean; t: ReturnType<typeof useTranslations> }) {
  return (
    <>
      <span className="navbar-count-num">
        <CountUp preserveValue end={display} separator="," duration={0.1} />
      </span>
      <span className="navbar-count-label">{t('strikes')}</span>
    </>
  );
}

export default function Navbar() {
  const path = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const { display, connected } = useNavCount();
  const { satellite, toggle: toggleSatellite } = useSatellite();
  const { sound, toggle: toggleSound } = useSound();
  const { locale, setLocale } = useLocale();
  const t = useTranslations('nav');

  useEffect(() => {
    if (!settingsOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [settingsOpen]);

  const tabs = [
    { href: '/',          label: t('strikemap') },
    { href: '/countries', label: t('bycountry') },
    { href: '/stats',     label: t('archive') },
  ];

  const langButtons = LOCALES.map(l => (
    <button key={l} className={`lang-btn${locale === l ? ' active' : ''}`} onClick={() => setLocale(l)}>
      <img src={`https://flagcdn.com/w20/${LOCALE_FLAGS[l]}.png`} width={16} height={12} alt={l} className="lang-flag" />
      {l.toUpperCase()}
    </button>
  ));

  const switches = (
    <>
      <div className="settings-toggles">
        <label className="settings-row" aria-label={t('toggleSatellite')}>
          <span className="settings-row-label">{t('satellite')}</span>
          <input type="checkbox" checked={satellite} onChange={toggleSatellite} />
          <span className="satellite-track"><span className="satellite-thumb" /></span>
        </label>
        <label className="settings-row" aria-label={t('toggleSound')}>
          <span className="settings-row-label">{t('sound')}</span>
          <input type="checkbox" checked={sound} onChange={toggleSound} />
          <span className="satellite-track"><span className="satellite-thumb" /></span>
        </label>
      </div>
      <div className="settings-langs">
        {langButtons}
      </div>
    </>
  );

  return (
    <>
      <nav className="navbar">
        <div className="navbar-brand" translate="no">
          <span className="site-icon">⚡</span>
          <span className="site-title">Lightning Stats</span>
        </div>

        <div className="navbar-tabs">
          {tabs.map(tab => (
            <Link key={tab.href} href={tab.href} className={`nav-tab${path === tab.href ? ' active' : ''}`}>
              {tab.label}
            </Link>
          ))}
        </div>

        <div className="navbar-sep" aria-hidden="true" />

        {/* Desktop ⚙ settings button + popover */}
        <div className="settings-btn-wrap" ref={settingsRef}>
          <button
            className={`settings-btn${settingsOpen ? ' active' : ''}`}
            onClick={() => setSettingsOpen(o => !o)}
            aria-label={t('settings')}
          >
            ⚙ {t('settings')}
          </button>
          {settingsOpen && (
            <div className="settings-popover">
              {switches}
            </div>
          )}
        </div>

        <div className="navbar-count">
          <StrikeCount display={display} connected={connected} t={t} />
        </div>

        <button
          className="navbar-menu-btn"
          onClick={() => setDrawerOpen(o => !o)}
          aria-label={t('toggleNav')}
          aria-expanded={drawerOpen}
        >
          {drawerOpen ? '✕' : '☰'}
        </button>
      </nav>

      {/* Mobile dropdown */}
      <div className={`navbar-dropdown${drawerOpen ? ' open' : ''}`}>
        <div className="drawer-switches">
          {switches}
        </div>
        {tabs.map(tab => (
          <Link key={tab.href} href={tab.href} className={`nav-tab${path === tab.href ? ' active' : ''}`} onClick={() => setDrawerOpen(false)}>
            {tab.label}
          </Link>
        ))}
      </div>

      <div className="navbar-stats-bar">
        <StrikeCount display={display} connected={connected} t={t} />
      </div>
    </>
  );
}
