import mqtt from 'mqtt';
import { getCountryCode } from '../../lib/geoCountry';
import { loadCounters, saveCounters, loadDailyStrikes, saveDailyAndPeaks, archiveGridStrikeBatch } from '../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Load persisted state once on startup
const { total, countries } = loadCounters();
let serverTotal = total;
const serverCountryCounts: Record<string, number> = { ...countries };
(globalThis as any)._serverTotal = serverTotal;

// Today tracking
function todayDate() { return new Date().toISOString().slice(0, 10); }
let currentDay = todayDate();
let todayCounts: Record<string, number> = { ...loadDailyStrikes(currentDay) };
(globalThis as any)._todayCounts = todayCounts;
(globalThis as any)._todayDate = currentDay;

// Buffer for grid strike archival — flushed to SQLite every 5s instead of per-strike
const pendingGridStrikes: Array<{ lat: number; lon: number; time: number }> = [];

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

// Flush counters to SQLite every 30 seconds
setInterval(() => {
  try {
    saveCounters(serverTotal, serverCountryCounts);
    saveDailyAndPeaks(currentDay, todayCounts);
  } catch (err) { console.error('[db] flush failed:', err); }
}, 30_000);

// Flush grid strikes in batches every 5 seconds
setInterval(() => {
  if (pendingGridStrikes.length === 0) return;
  const batch = pendingGridStrikes.splice(0);
  try { archiveGridStrikeBatch(batch); } catch (err) { console.error('[db] grid batch failed:', err); }
}, 5_000);

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
            // Day rollover check
            const today = todayDate();
            if (today !== currentDay) {
              saveDailyAndPeaks(currentDay, todayCounts);
              todayCounts = {};
              currentDay = today;
              (globalThis as any)._todayDate = currentDay;
              (globalThis as any)._todayCounts = todayCounts;
            }

            let cc: string | null = null;
            try { cc = getCountryCode(d.lat, d.lon); } catch { /* non-fatal */ }
            serverTotal++;
            (globalThis as any)._serverTotal = serverTotal;
            if (cc) {
              serverCountryCounts[cc] = (serverCountryCounts[cc] ?? 0) + 1;
              todayCounts[cc] = (todayCounts[cc] ?? 0) + 1;
            }
            recentStrikes.push({ lat: d.lat, lon: d.lon, cc, time: Date.now() });
            pendingGridStrikes.push({ lat: d.lat, lon: d.lon, time: Date.now() });
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
