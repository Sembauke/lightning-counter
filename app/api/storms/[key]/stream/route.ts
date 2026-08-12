import { NextRequest } from 'next/server';
import { registerStrikeSubscriber, unregisterStrikeSubscriber } from '../../../../lib/strikeStream';
import { getStormByKey, getViewportStrikes } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const stormKey = decodeURIComponent(key);

  const storm = getStormByKey(stormKey);
  if (!storm) return new Response('not found', { status: 404 });

  const { lat, lon } = storm;
  // 100 km covers the full storm footprint (MERGE_KM=75) with room to move
  const RADIUS_KM = 100;
  const id = `${stormKey}:${Math.random().toString(36).slice(2)}`;
  const enc = new TextEncoder();

  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  let heartbeatTimer: ReturnType<typeof setInterval>;

  const cosLat = Math.cos(lat * Math.PI / 180);

  // History: last 10 min of persisted grid_strikes within storm radius.
  // Sent as a named SSE event so the client can seed appendedStrikes without
  // counting them against appendedSinceFlush.
  const LAT_DEG = RADIUS_KM / 111.32;
  const LON_DEG = RADIUS_KM / (111.32 * cosLat);
  const gridRows = getViewportStrikes(
    lat - LAT_DEG, lat + LAT_DEG,
    lon - LON_DEG, lon + LON_DEG,
    Date.now() - 10 * 60_000,
    5000
  );
  const historyBatch: Array<[number, number, number]> = gridRows
    .map(s => [s.lat, s.lon, s.strike_time] as [number, number, number]);
  historyBatch.sort((a, b) => a[2] - b[2]);
  const maxHistoryTs = historyBatch.length > 0 ? historyBatch[historyBatch.length - 1][2] : 0;

  // Live tail: in-memory strikes not yet persisted to grid_strikes (last ~5 s).
  const recentGlobal: Array<{ lat: number; lon: number; time: number }> =
    (globalThis as any)._recentStrikes ?? [];
const r2 = RADIUS_KM * RADIUS_KM;
  const liveTail: Array<[number, number, number]> = [];
  for (const s of recentGlobal) {
    if (s.time <= maxHistoryTs) continue;
    const dLat = (s.lat - lat) * 111.32;
    const dLon = (s.lon - lon) * 111.32 * cosLat;
    if (dLat * dLat + dLon * dLon <= r2) liveTail.push([s.lat, s.lon, s.time]);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      // History batch restores all visible strikes from the last 10 min.
      if (historyBatch.length > 0) {
        try { ctrl.enqueue(enc.encode(`event: history\ndata: ${JSON.stringify(historyBatch)}\n\n`)); } catch {}
      }
      // Very-recent strikes not yet written to grid_strikes.
      for (const strike of liveTail) {
        try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(strike)}\n\n`)); } catch {}
      }
      registerStrikeSubscriber(id, {
        lat, lon, radiusKm: RADIUS_KM,
        send: (strike) => {
          try {
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify(strike)}\n\n`));
          } catch {
            unregisterStrikeSubscriber(id);
          }
        },
      });
      heartbeatTimer = setInterval(() => {
        try { ctrl.enqueue(enc.encode(': heartbeat\n\n')); }
        catch { clearInterval(heartbeatTimer); unregisterStrikeSubscriber(id); }
      }, 25_000);

      req.signal.addEventListener('abort', () => {
        clearInterval(heartbeatTimer);
        unregisterStrikeSubscriber(id);
        try { ctrl.close(); } catch {}
      });
    },
    cancel() {
      clearInterval(heartbeatTimer);
      unregisterStrikeSubscriber(id);
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
