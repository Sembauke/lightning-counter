import { NextRequest } from 'next/server';
import { registerStrikeSubscriber, unregisterStrikeSubscriber } from '../../../../lib/strikeStream';
import { getStormByKey } from '../../../../lib/db';

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

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
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
