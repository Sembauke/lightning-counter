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
function onStrike(lat, lon) {
  if (typeof globalThis._processStrike === 'function') {
    globalThis._processStrike(lat, lon);
  } else {
    globalThis._strikeQueue.push({ lat, lon });
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
              if (!isWsDuplicate(s.id, s.src)) onStrike(s.lat, s.lon);
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
});
