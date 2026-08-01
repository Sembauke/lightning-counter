import { createServer } from 'http';
import { parse } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import next from 'next';

const port = parseInt(process.env.PORT ?? '3000', 10);
const dev = process.env.NODE_ENV !== 'production';

// Shared state (read by app/api/strikes/route.ts)
globalThis._wsClients = new Set();
globalThis._serverTotal = 0;
globalThis._activeSources = new Set();
globalThis._recentStrikes = [];
globalThis._strikeQueue = [];         // raw strikes waiting for route.ts to process
globalThis._sseControllers = new Set();
globalThis._seenStrikeIds = new Set();
globalThis._seenStrikeQueue = [];

const SEEN_IDS_MAX = 50_000;

function isWsDuplicate(id, src) {
  const key = `${id}-${src}`;
  if (globalThis._seenStrikeIds.has(key)) return true;
  globalThis._seenStrikeIds.add(key);
  globalThis._seenStrikeQueue.push(key);
  if (globalThis._seenStrikeQueue.length > SEEN_IDS_MAX) {
    globalThis._seenStrikeIds.delete(globalThis._seenStrikeQueue.shift());
  }
  return false;
}

function broadcastSSE(chunk) {
  const buf = Buffer.from(chunk);
  for (const ctrl of globalThis._sseControllers) {
    try { ctrl.enqueue(new Uint8Array(buf)); } catch { globalThis._sseControllers.delete(ctrl); }
  }
}

function markConnected(source) {
  const wasEmpty = globalThis._activeSources.size === 0;
  globalThis._activeSources.add(source);
  if (wasEmpty) broadcastSSE('event: status\ndata: live\n\n');
  console.log(`[blitz] connected: ${source} (${globalThis._activeSources.size} total)`);
}

function markDisconnected(source) {
  globalThis._activeSources.delete(source);
  if (globalThis._activeSources.size === 0) broadcastSSE('event: status\ndata: reconnecting\n\n');
  console.log(`[blitz] disconnected: ${source} (${globalThis._activeSources.size} remaining)`);
}

// Strike processor — called by route.ts once it has loaded geo/db imports
// Falls back to a queue if route.ts not yet initialised
function onStrike(lat, lon, time) {
  if (typeof globalThis._processStrike === 'function') {
    globalThis._processStrike(lat, lon, time);
  } else {
    globalThis._strikeQueue.push({ lat, lon, time });
  }
}

// ── Lightningmaps WebSocket servers ──────────────────────────────────────
const LM_WS = [
  'wss://live.lightningmaps.org',
  'wss://live2.lightningmaps.org',
];

function connectLMWS(url) {
  const name = url.replace('wss://', '');
  const connect = () => {
    const ws = new WebSocket(url, {
      headers: { Origin: 'https://www.lightningmaps.org' },
      handshakeTimeout: 15_000,
      rejectUnauthorized: false,
    });

    let heartbeat = null;

    ws.on('open', () => {
      markConnected(name);
      const sendUpdate = (reason) => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify({
          v: 24, i: {}, s: false, x: 0, w: 0, tx: 0, tw: 1,
          a: 4, z: 3, b: true, h: '', l: 0,
          t: Math.floor(Date.now() / 1000),
          r: reason,
          p: [90, 180, -90, -180],
        }));
      };
      sendUpdate({});
      heartbeat = setInterval(() => sendUpdate('w'), 45_000);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (typeof msg.k === 'number') {
          ws.send(`{"k": ${(msg.k * 3604) % 7081 * Date.now() / 100} }`);
        } else if (Array.isArray(msg.strokes)) {
          for (const s of msg.strokes) {
            if (typeof s.lat === 'number' && typeof s.lon === 'number') {
              // s.time is the actual discharge time — arrival time would collapse
              // reconnect backlogs into artificial bursts
              if (!isWsDuplicate(s.id, s.src)) onStrike(s.lat, s.lon, s.time);
            }
          }
        }
      } catch { /* ignore */ }
    });

    ws.on('error', (err) => console.error(`[${name}] error:`, err.message));
    ws.on('close', (code, reason) => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      console.log(`[${name}] closed: ${code} ${reason?.toString()}`);
      markDisconnected(name);
      setTimeout(connect, 5_000);
    });
  };
  connect();
}

const app = next({ dev, hostname: '0.0.0.0', port });
const handle = app.getRequestHandler();

await app.prepare();

// Start lightning data connections after Next.js is ready
LM_WS.forEach(connectLMWS);

const server = createServer(async (req, res) => {
  const parsedUrl = parse(req.url, true);
  await handle(req, res, parsedUrl);
});

const wss = new WebSocketServer({ server, path: '/ws' });

const broadcast = () => {
  const msg = JSON.stringify({ total: globalThis._serverTotal, viewers: globalThis._wsClients.size });
  for (const ws of globalThis._wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
};

wss.on('connection', (ws) => {
  globalThis._wsClients.add(ws);
  ws.send(JSON.stringify({ total: globalThis._serverTotal, viewers: globalThis._wsClients.size }));
  broadcast();
  ws.on('close', () => { globalThis._wsClients.delete(ws); broadcast(); });
  ws.on('error', () => { globalThis._wsClients.delete(ws); broadcast(); });
});

setInterval(() => {
  if (globalThis._wsClients.size === 0) return;
  broadcast();
}, 1000);

server.listen(port, '0.0.0.0', () => {
  console.log(`> Ready on http://0.0.0.0:${port}`);
  // Pre-warm the home page so Next.js compiles the LightningMap chunk before
  // the first user request. Without this, the initial page load triggers a
  // cold compile that shows "Loading map…" for several seconds.
  setTimeout(() => {
    fetch(`http://127.0.0.1:${port}/`).catch(() => {});
  }, 500);
});

// ── Dev storm ──────────────────────────────────────────────────────────────
// Always-live fake storm so the storm detail page can be inspected in dev
// without waiting for real activity. Kept alive by refreshing end_time and
// dripping one fake strike per 30 s through the normal SSE pipeline.
if (dev) {
  // Delay so the pre-warm request has time to fire and initialize the DB schema
  setTimeout(async () => {
    const { createRequire } = await import('module');
    const load = createRequire(import.meta.url);
    const Database = load('better-sqlite3');
    const { existsSync, mkdirSync } = await import('fs');
    const { join } = await import('path');

    const DB_DIR = process.env.DB_PATH ?? (existsSync('/data') ? '/data' : './tmp');
    mkdirSync(DB_DIR, { recursive: true });
    const devDb = new Database(join(DB_DIR, 'lightning.db'));

    const DEV_KEY = '__dev__';
    const DEV_LAT = 52.3;
    const DEV_LON = 4.9;
    const now = Date.now();
    const startTime = now - 90 * 60_000;

    // 250 fake strikes spread over the last 90 min around Amsterdam
    // Cap timestamps to now - 2s so latestTsRef never blocks incoming SSE strikes
    const strikes = Array.from({ length: 250 }, (_, i) => {
      const t = Math.min(now - 2_000, startTime + (i / 249) * 90 * 60_000 + (Math.random() - 0.5) * 60_000);
      return [
        DEV_LAT + (Math.random() - 0.5) * 0.8,
        DEV_LON + (Math.random() - 0.5) * 1.2,
        Math.round(t),
      ];
    }).sort((a, b) => a[2] - b[2]);

    const today = new Date().toISOString().slice(0, 10);

    devDb.prepare(`
      INSERT INTO storms (storm_key, code, count, rate, lat, lon, city, date,
                          start_time, end_time, total_count, strikes)
      VALUES (?, 'NL', 250, 48, ?, ?, 'Amsterdam (Dev)', ?, ?, ?, 250, ?)
      ON CONFLICT(storm_key) DO UPDATE SET
        end_time   = excluded.end_time,
        start_time = COALESCE(start_time, excluded.start_time)
    `).run(DEV_KEY, DEV_LAT, DEV_LON, today, startTime, now, JSON.stringify(strikes));

    console.log(`[dev] storm ready → http://localhost:${port}/storms/${encodeURIComponent(DEV_KEY)}`);

    // Keep end_time within the "live" window (< 10 min old)
    setInterval(() => {
      devDb.prepare('UPDATE storms SET end_time = ? WHERE storm_key = ?').run(Date.now(), DEV_KEY);
    }, 5 * 60_000);

    // Drip fake strikes at 2/s — dispatch directly to open storm SSE subscribers
    // (bypasses _processStrike which only loads when /api/strikes is first hit)
    setInterval(() => {
      const lat = DEV_LAT + (Math.random() - 0.5) * 0.6;
      const lon = DEV_LON + (Math.random() - 0.5) * 0.9;
      const time = Date.now();
      const subs = globalThis._stormStrikeSubscribers;
      if (subs?.size > 0) {
        for (const sub of subs.values()) {
          const dLat = (lat - sub.lat) * 111.32;
          const dLon = (lon - sub.lon) * 111.32 * Math.cos(((lat + sub.lat) / 2) * Math.PI / 180);
          if (Math.hypot(dLat, dLon) <= sub.radiusKm) {
            try { sub.send([lat, lon, time]); } catch {}
          }
        }
      }
    }, 500);
  }, 3_000);
}
