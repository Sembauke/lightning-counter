import { createServer } from 'http';
import { parse } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import next from 'next';

const port = parseInt(process.env.PORT ?? '3000', 10);
const dev = process.env.NODE_ENV !== 'production';

// Shared with API route via globalThis so route.ts can update the total
globalThis._wsClients = new Set();
globalThis._serverTotal = 0;

const app = next({ dev, hostname: '0.0.0.0', port });
const handle = app.getRequestHandler();

await app.prepare();

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
  // Send current state immediately, then notify everyone of new viewer count
  ws.send(JSON.stringify({ total: globalThis._serverTotal, viewers: globalThis._wsClients.size }));
  broadcast();
  ws.on('close', () => { globalThis._wsClients.delete(ws); broadcast(); });
  ws.on('error', () => { globalThis._wsClients.delete(ws); broadcast(); });
});

// Broadcast total to all clients every second
setInterval(() => {
  if (globalThis._wsClients.size === 0) return;
  broadcast();
}, 1000);

server.listen(port, '0.0.0.0', () => {
  console.log(`> Ready on http://0.0.0.0:${port}`);
});
