import { NextRequest } from 'next/server';
import { registerStrikeSubscriber, unregisterStrikeSubscriber, findStormStrikeOwner, stormStrikeHistory } from '../../../../lib/strikeStream';
import { getStormByKey, resolveStormKey } from '../../../../lib/db';
import { ownedStrikeId } from '../../../../lib/stormStrikeOwnership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const requestedKey = decodeURIComponent(key);
  const storm = getStormByKey(requestedKey);
  if (!storm) return new Response('not found', { status: 404 });
  const stormKey = storm.stormKey ?? requestedKey;
  const id = `${stormKey}:${Math.random().toString(36).slice(2)}`;
  const enc = new TextEncoder();

  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  let heartbeatTimer: ReturnType<typeof setInterval>;

  // Seed only this identity's assigned lifecycle/replay points. In particular,
  // confirmed nearby children must not import each other's raw-grid history.
  const historyBatch = stormStrikeHistory(stormKey, storm.strikes);
  const seen = new Set(historyBatch.map(([lat, lon, time]) => ownedStrikeId({ lat, lon, time })));
  const maxHistoryTs = historyBatch.length > 0 ? historyBatch[historyBatch.length - 1][2] : 0;

  // Live tail: in-memory strikes not yet persisted to grid_strikes (last ~5 s).
  const recentGlobal: Array<{ lat: number; lon: number; time: number }> =
    (globalThis as any)._recentStrikes ?? [];
  const liveTail: Array<[number, number, number]> = [];
  for (const s of recentGlobal) {
    if (s.time <= maxHistoryTs) continue;
    const owner = findStormStrikeOwner(s.lat, s.lon, s.time);
    const id = ownedStrikeId(s);
    if (owner?.active && owner.key === stormKey && !seen.has(id)) {
      liveTail.push([s.lat, s.lon, s.time]);
      seen.add(id);
    }
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
        stormKey,
        resolveKey: () => resolveStormKey(stormKey),
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
