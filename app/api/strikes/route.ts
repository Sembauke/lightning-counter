import mqtt from 'mqtt';
import { getCountryCode } from '../../lib/geoCountry';
import { loadCounters, saveCounters } from '../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Load persisted state once on startup
const { total, countries } = loadCounters();
let serverTotal = total;
const serverCountryCounts: Record<string, number> = { ...countries };
// Sync to globalThis so server.mjs WebSocket can broadcast the total
(globalThis as any)._serverTotal = serverTotal;

// Ring buffer of recent strikes for map history on reconnect (last 30 min, max 5000)
interface RecentStrike { lat: number; lon: number; cc: string | null; time: number }
const recentStrikes: RecentStrike[] = [];
const MAX_HISTORY = 5000;
const HISTORY_LIFETIME_MS = 30 * 60 * 1000;

// Prune strikes older than 30 min every minute
setInterval(() => {
  const cutoff = Date.now() - HISTORY_LIFETIME_MS;
  while (recentStrikes.length > 0 && recentStrikes[0].time < cutoff) recentStrikes.shift();
}, 60_000);

// Flush to SQLite every 30 seconds
setInterval(() => {
  try { saveCounters(serverTotal, serverCountryCounts); } catch (err) { console.error('[db] flush failed:', err); }
}, 30_000);

export async function GET() {
  let client: ReturnType<typeof mqtt.connect> | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const enc = new TextEncoder();

  function send(chunk: string) {
    try { controller?.enqueue(enc.encode(chunk)); } catch { /* stream closed */ }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
      heartbeatTimer = setInterval(() => send(': heartbeat\n\n'), 25_000);

      send(`event: init\ndata: ${JSON.stringify({ total: serverTotal, countries: serverCountryCounts })}\n\n`);
      // Send map history so dots reappear after a page refresh
      if (recentStrikes.length > 0) {
        send(`event: history\ndata: ${JSON.stringify(recentStrikes)}\n\n`);
      }

      client = mqtt.connect('mqtt://blitzortung.ha.sed.pl:1883', {
        connectTimeout: 10_000,
        reconnectPeriod: 5_000,
        clientId: `lc_${Math.random().toString(16).slice(2)}`,
      });

      client.on('connect', () => {
        send('event: status\ndata: live\n\n');
        client!.subscribe('blitzortung/1.1/#', { qos: 0 });
      });

      client.on('message', (_topic, payload) => {
        try {
          const d = JSON.parse(payload.toString()) as { lat: number; lon: number };
          if (typeof d.lat === 'number' && typeof d.lon === 'number') {
            let cc: string | null = null;
            try { cc = getCountryCode(d.lat, d.lon); } catch { /* non-fatal */ }
            serverTotal++;
            (globalThis as any)._serverTotal = serverTotal;
            if (cc) serverCountryCounts[cc] = (serverCountryCounts[cc] ?? 0) + 1;
            recentStrikes.push({ lat: d.lat, lon: d.lon, cc, time: Date.now() });
            if (recentStrikes.length > MAX_HISTORY) recentStrikes.shift();
            send(`data: ${JSON.stringify({ lat: d.lat, lon: d.lon, cc })}\n\n`);
          }
        } catch { /* ignore */ }
      });

      client.on('reconnect', () => send('event: status\ndata: reconnecting\n\n'));
      client.on('error', (err) => console.error('[mqtt]', err.message));
    },
    cancel() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      client?.end(true);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
