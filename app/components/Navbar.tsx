'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useSound } from '../context/SoundContext';
import { useLocale, LOCALES, type Locale } from '../context/LocaleContext';
import { useHeatmap } from '../context/HeatmapContext';
import { useCountryTooltip } from '../context/TooltipContext';

const StormActivity = dynamic(() => import('./StormActivity'), { ssr: false });

const LOCALE_FLAGS: Record<Locale, string> = { en: 'gb', nl: 'nl', de: 'de', fr: 'fr', es: 'es' };

function useNavCount() {
  const [display, setDisplay] = useState(0);
  const [connected, setConnected] = useState(false);
  const [viewers, setViewers] = useState(0);
  const [strikeRate, setStrikeRate] = useState(0);
  const targetRef = useRef(0);
  const seededRef = useRef(false);
  const rateBufRef = useRef<Array<{ total: number; ts: number }>>([]);

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;
    let destroyed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          if (typeof d.total === 'number' && !isNaN(d.total)) {
            targetRef.current = d.total;
            if (!seededRef.current) {
              seededRef.current = true;
              setDisplay(d.total);
            }
            // Rolling 30-second rate window
            const now = Date.now();
            const buf = rateBufRef.current;
            buf.push({ total: d.total, ts: now });
            // Drop samples older than 30 s
            const cutoff = now - 30_000;
            while (buf.length > 1 && buf[0].ts < cutoff) buf.shift();
            if (buf.length >= 2) {
              const spanSec = (buf[buf.length - 1].ts - buf[0].ts) / 1000;
              if (spanSec > 0) setStrikeRate((buf[buf.length - 1].total - buf[0].total) / spanSec);
            }
          }
          if (typeof d.viewers === 'number') setViewers(d.viewers);
        } catch { /* ignore */ }
      };
      ws.onopen = () => { setConnected(true); delay = 1000; };
      ws.onclose = () => {
        setConnected(false);
        if (!destroyed) {
          reconnectTimer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 30_000);
        }
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  // Snap to current total immediately when the tab regains focus
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setDisplay(targetRef.current);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
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

  return { display, connected, viewers, strikeRate };
}

function StrikeCount({ display, viewers, strikeRate, t }: { display: number; connected: boolean; viewers: number; strikeRate: number; t: ReturnType<typeof useTranslations> }) {
  return (
    <>
      <span className="navbar-count-main" data-rate={strikeRate > 0 ? `${strikeRate.toFixed(1)}/s` : undefined}>
        <span className="navbar-count-num">
          {display.toLocaleString()}
        </span>
        <span className="navbar-count-label">{t('strikes')}</span>
      </span>
      {viewers > 0 && (
        <span className="navbar-count-viewers">
          <span className="navbar-viewers">{viewers} {t('watching')}</span>
        </span>
      )}
    </>
  );
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);
  return { open, setOpen, ref };
}

export default function Navbar() {
  const path = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [stormOpen, setStormOpen] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem('stormOpen');
    if (saved !== null) setStormOpen(saved === 'true');
    // Default on for desktop; the bottom-sheet layout is too intrusive on phones
    else setStormOpen(window.matchMedia('(min-width: 641px)').matches);
  }, []);
  const settings = usePopover();
  const tools = usePopover();
  const { display, connected, viewers, strikeRate } = useNavCount();
  const { sound, toggle: toggleSound } = useSound();
  const { enabled: heatmapEnabled, toggle: toggleHeatmap } = useHeatmap();
  const { enabled: tooltipEnabled, toggle: toggleTooltip } = useCountryTooltip();
  const { locale, setLocale } = useLocale();
  const t = useTranslations('nav');

  const tabs = [
    { href: '/',        label: t('strikemap') },
    { href: '/stats',   label: t('archive') },
    { href: '/storms',  label: t('storms') },
    { href: '/records', label: t('records') },
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

  const toolsSwitches = (
    <div className="settings-toggles">
      <label className="settings-row" aria-label={t('toggleHeatmap')}>
        <span className="settings-row-label">{t('heatmap')}</span>
        <input type="checkbox" checked={heatmapEnabled} onChange={toggleHeatmap} />
        <span className="satellite-track"><span className="satellite-thumb" /></span>
      </label>
      <label className="settings-row">
        <span className="settings-row-label">{t('stormActivity')}</span>
        <input type="checkbox" checked={stormOpen} onChange={() => setStormOpen(o => { const next = !o; localStorage.setItem('stormOpen', String(next)); return next; })} />
        <span className="satellite-track"><span className="satellite-thumb" /></span>
      </label>
      <label className="settings-row">
        <span className="settings-row-label">{t('countryTooltip')}</span>
        <input type="checkbox" checked={tooltipEnabled} onChange={toggleTooltip} />
        <span className="satellite-track"><span className="satellite-thumb" /></span>
      </label>
    </div>
  );

  return (
    <>
      <nav className="navbar">
        <Link href="/" className="navbar-brand" translate="no">
          <span className="site-icon">⚡</span>
          <span className="site-title">Lightning Stats</span>
        </Link>

        <div className="navbar-sep" aria-hidden="true" />

        {/* Desktop page links — the mobile drawer covers navigation on phones */}
        <Link href="/stats"    className={`navbar-page-link${path === '/stats'    ? ' active' : ''}`}>{t('archive')}</Link>
        <Link href="/storms"   className={`navbar-page-link${path === '/storms'   ? ' active' : ''}`}>{t('storms')}</Link>
        <Link href="/records"  className={`navbar-page-link${path === '/records'  ? ' active' : ''}`}>{t('records')}</Link>

        <div className="navbar-sep" aria-hidden="true" />

        {/* Desktop Tools popover */}
        <div className="settings-btn-wrap" ref={tools.ref}>
          <button
            className={`settings-btn${tools.open ? ' active' : ''}`}
            onClick={() => tools.setOpen(o => !o)}
          >
            {t('tools')} ▾
          </button>
          {tools.open && (
            <div className="settings-popover">
              {toolsSwitches}
            </div>
          )}
        </div>

        {/* Desktop settings popover */}
        <div className="settings-btn-wrap" ref={settings.ref}>
          <button
            className={`settings-btn${settings.open ? ' active' : ''}`}
            onClick={() => settings.setOpen(o => !o)}
            aria-label={t('settings')}
          >
            {t('settings')}
          </button>
          {settings.open && (
            <div className="settings-popover">
              {switches}
            </div>
          )}
        </div>

        <div className="navbar-sep" aria-hidden="true" />

        <div className="navbar-count">
          <StrikeCount display={display} connected={connected} viewers={viewers} strikeRate={strikeRate} t={t} />
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
        <div className="drawer-switches">
          {toolsSwitches}
        </div>
        {tabs.map(tab => (
          <Link key={tab.href} href={tab.href} className={`nav-tab${path === tab.href ? ' active' : ''}`} onClick={() => setDrawerOpen(false)}>
            {tab.label}
          </Link>
        ))}
      </div>

      <div className="navbar-stats-bar">
        <StrikeCount display={display} connected={connected} viewers={viewers} strikeRate={strikeRate} t={t} />
      </div>

      {stormOpen && path === '/' && <StormActivity />}
    </>
  );
}
