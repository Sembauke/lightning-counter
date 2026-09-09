import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type Handler = (...args: any[]) => void;
type BootstrapAttempt = {
  url: string;
  options: RequestInit;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
};

const timerKeys = ['_iv_histPrune', '_iv_dbFlush', '_iv_gridBatch', '_iv_hourly'];
const globals = globalThis as typeof globalThis & Record<string, any>;
const port = 31415;
let requestHandler: Handler;
let onListening: Handler;
let upstreams: MockSocket[];
let attempts: BootstrapAttempt[];
let frameworkHandler: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let processor: ReturnType<typeof vi.fn>;
let homepageFails: boolean;

class MockSocket {
  static OPEN = 1;
  readyState = 1;
  handlers = new Map<string, Handler[]>();
  send = vi.fn();
  terminate = vi.fn(() => { this.readyState = 3; this.emit('close', 1006); });
  constructor(readonly url: string, readonly options: { rejectUnauthorized?: boolean } = {}) { upstreams.push(this); }
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...this.handlers.get(event) ?? [], handler]);
    return this;
  }
  emit(event: string, ...args: any[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 8, 9, 18));
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PORT', String(port));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const key of ['_processStrike', '_ingestionReady', ...timerKeys]) delete globals[key];
  upstreams = [];
  attempts = [];
  homepageFails = false;
  frameworkHandler = vi.fn(async (_request, response) => { response.end('homepage'); });
  processor = vi.fn((lat: number, lon: number, time: number) => {
    globals._serverTotal++;
    globals._recentStrikes.push({ lat, lon, time });
  });
  fetchMock = vi.fn((input: string | URL | Request, options: RequestInit = {}) => {
    const url = String(input);
    if (new URL(url).pathname !== '/api/strikes') {
      return homepageFails ? Promise.reject(new Error('homepage unavailable')) : Promise.resolve(new Response('homepage'));
    }
    return new Promise<Response>((resolve, reject) => {
      attempts.push({ url, options, resolve, reject });
      options.signal?.addEventListener('abort', () => reject(new Error('bootstrap aborted')), { once: true });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.doMock('http', () => ({ createServer: (handler: Handler) => {
    requestHandler = handler;
    const server = { listen: vi.fn((_port: number, _host: string, callback: Handler) => {
      onListening = callback;
      return server;
    }) };
    return server;
  } }));
  vi.doMock('next', () => ({ default: () => ({ prepare: async () => {}, getRequestHandler: () => frameworkHandler }) }));
  vi.doMock('ws', () => ({ WebSocket: MockSocket, WebSocketServer: class { on = vi.fn(); } }));
});

afterEach(() => {
  if (globals._ingestionSignalHandler) {
    process.off('SIGTERM', globals._ingestionSignalHandler);
    process.off('SIGINT', globals._ingestionSignalHandler);
    delete globals._ingestionSignalHandler;
  }
  delete globals._stopIngestion;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ['_wsClients', '_serverTotal', '_activeSources', '_recentStrikes', '_strikeQueue', '_sseControllers',
    '_seenStrikeIds', '_seenStrikeQueue', '_processStrike', '_ingestionReady', ...timerKeys]) delete globals[key];
});

async function startListening() {
  // @ts-expect-error The actual JavaScript server entrypoint has no TypeScript declarations.
  await import('../server.mjs');
  expect(upstreams).toHaveLength(0);
  onListening();
  await vi.advanceTimersByTimeAsync(0);
}

function installProcessor(timerCount = timerKeys.length) {
  globals._processStrike = processor;
  const captured = new Map<string, ReturnType<typeof setInterval>>();
  for (const [index, key] of timerKeys.entries()) {
    if (globals[key]) clearInterval(globals[key]);
    delete globals[key];
    if (index < timerCount) {
      const timer = setInterval(() => {}, 30_000);
      globals[key] = timer;
      captured.set(key, timer);
    }
  }
  // Model the route's completion hook: merely resolving HTTP200 does not
  // establish ingestion without the processor and every captured timer.
  globals._ingestionReady = () => globals._processStrike === processor
    && timerKeys.every(key => captured.has(key) && globals[key] === captured.get(key) && globals[key]?._destroyed !== true);
}

async function request(url: string) {
  let body = '';
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
    writeHead(status: number, headers: Record<string, string> = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      return this;
    },
    end(value = '') { body = String(value); },
  };
  await requestHandler({ url, method: 'GET' }, response);
  return { ...response, body };
}

async function expectHealth(status: number, state: 'starting' | 'ready') {
  const result = await request('/healthz');
  expect(result.statusCode).toBe(status);
  expect(JSON.parse(result.body)).toEqual({ status: state });
  expect(result.headers['cache-control']).toBe('no-store');
}

it('boots ingestion before connecting either feed and processes lightning with no visitors', async () => {
  await startListening();
  await expectHealth(503, 'starting');
  expect(frameworkHandler).not.toHaveBeenCalled();
  expect(attempts).toHaveLength(1);
  expect(attempts[0].url).toBe(`http://127.0.0.1:${port}/api/strikes`);
  expect(attempts[0].options.method).toBe('HEAD');
  expect(attempts[0].options.signal).toBeInstanceOf(AbortSignal);
  expect(upstreams).toHaveLength(0);

  installProcessor();
  await expectHealth(503, 'starting');
  attempts[0].resolve(new Response(null, { status: 200 }));
  await vi.advanceTimersByTimeAsync(0);
  await expectHealth(200, 'ready');
  expect(upstreams.map(socket => socket.url)).toEqual(['wss://live.lightningmaps.org', 'wss://live2.lightningmaps.org']);
  // Both production feed connections must validate their certificates.
  expect(upstreams.every(socket => socket.options.rejectUnauthorized === true)).toBe(true);
  expect(globals._sseControllers.size).toBe(0);
  expect(globals._wsClients.size).toBe(0);

  for (const socket of upstreams) socket.emit('open');
  const time = Date.now() - 1000;
  const payload = Buffer.from(JSON.stringify({ strokes: [{ lat: 45, lon: 7, time }] }));
  upstreams[0].emit('message', payload);
  upstreams[1].emit('message', payload);
  expect(processor).toHaveBeenCalledExactlyOnceWith(45, 7, time);
  expect(globals._serverTotal).toBe(1);
  expect(globals._strikeQueue).toEqual([]);

  await vi.advanceTimersByTimeAsync(31_000);
  for (let i = 0; i < 3; i++) await expectHealth(200, 'ready');
  expect(attempts).toHaveLength(1);
  expect(upstreams).toHaveLength(2);
  expect(globals._sseControllers.size).toBe(0);
  expect(frameworkHandler).not.toHaveBeenCalled();
});

it('retries failed and incomplete bootstrap attempts while health stays unready despite a working homepage', async () => {
  await startListening();
  attempts[0].resolve(new Response(null, { status: 503 }));
  await vi.advanceTimersByTimeAsync(0);
  expect((await request('/')).statusCode).toBe(200);
  await expectHealth(503, 'starting');
  expect(upstreams).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(4999);
  expect(attempts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(attempts).toHaveLength(2);

  installProcessor(3);
  attempts[1].resolve(new Response(null, { status: 200 }));
  await vi.advanceTimersByTimeAsync(0);
  await expectHealth(503, 'starting');
  expect(upstreams).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(5000);
  expect(attempts).toHaveLength(3);
  installProcessor();
  attempts[2].resolve(new Response(null, { status: 200 }));
  await vi.advanceTimersByTimeAsync(0);
  await expectHealth(200, 'ready');
  expect(upstreams).toHaveLength(2);
  expect(attempts.every(attempt => attempt.options.method === 'HEAD')).toBe(true);
});

it('aborts a hung bootstrap after thirty seconds and retries without prematurely starting feeds', async () => {
  await startListening();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(attempts[0].options.signal!.aborted).toBe(false);
  expect(upstreams).toHaveLength(0);
  await expectHealth(503, 'starting');
  await vi.advanceTimersByTimeAsync(1);
  expect(attempts[0].options.signal!.aborted).toBe(true);
  expect(attempts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(4999);
  expect(attempts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(attempts).toHaveLength(2);
  installProcessor();
  attempts[1].resolve(new Response(null, { status: 200 }));
  await vi.advanceTimersByTimeAsync(0);
  await expectHealth(200, 'ready');
  expect(upstreams).toHaveLength(2);
});

it('keeps readiness independent of homepage warming and reports missing ingestion timers after startup', async () => {
  homepageFails = true;
  await startListening();
  installProcessor();
  attempts[0].resolve(new Response(null, { status: 200 }));
  await vi.advanceTimersByTimeAsync(500);
  await expectHealth(200, 'ready');
  expect(upstreams).toHaveLength(2);

  clearInterval(globals._iv_dbFlush);
  delete globals._iv_dbFlush;
  await expectHealth(503, 'starting');
  await vi.advanceTimersByTimeAsync(5000);
  expect(attempts).toHaveLength(1);
  expect(upstreams).toHaveLength(2);
  expect(frameworkHandler).not.toHaveBeenCalled();
});


it('closes feeds and pending reconnects before flushing once on shutdown', async () => {
  await startListening();
  installProcessor();
  attempts[0].resolve(new Response(null, { status: 200 }));
  await vi.advanceTimersByTimeAsync(0);
  for (const socket of upstreams) socket.emit('open');
  upstreams[0].readyState = 3;
  upstreams[0].emit('close', 1006); // A reconnect is waiting when shutdown arrives.
  const stop = vi.fn(() => {
    expect(upstreams.every(socket => socket.readyState === 3)).toBe(true);
    expect(upstreams[1].terminate).toHaveBeenCalledOnce();
    for (const key of timerKeys) clearInterval(globals[key]);
  });
  globals._stopIngestion = stop;
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  expect(process.listeners('SIGTERM')).toContain(globals._ingestionSignalHandler);
  expect(process.listeners('SIGINT')).toContain(globals._ingestionSignalHandler);
  globals._ingestionSignalHandler();
  globals._ingestionSignalHandler();
  await vi.advanceTimersByTimeAsync(0);
  expect(stop).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  await expectHealth(503, 'starting');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(upstreams).toHaveLength(2);
  expect(exit).toHaveBeenCalledOnce();
});
