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

wss.on('connection', (ws) => {
  // Send current total immediately on connect
  ws.send(JSON.stringify({ total: globalThis._serverTotal }));
  globalThis._wsClients.add(ws);
  ws.on('close', () => globalThis._wsClients.delete(ws));
  ws.on('error', () => globalThis._wsClients.delete(ws));
});

// Broadcast total to all clients every second
setInterval(() => {
  if (globalThis._wsClients.size === 0) return;
  const msg = JSON.stringify({ total: globalThis._serverTotal });
  for (const ws of globalThis._wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}, 1000);

server.listen(port, '0.0.0.0', () => {
  console.log(`> Ready on http://0.0.0.0:${port}`);
});
