/** Run after `npm run build`: real production server, Next route, sockets,
 * signals, and SQLite. The test loader redirects only upstream feed URLs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { WebSocket, WebSocketServer } from 'ws';
const root = process.cwd();
assert(fs.existsSync(path.join(root, '.next/BUILD_ID')), 'Run npm run build first');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-real-durability-'));
const feed = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(feed, 'listening');
const feedUrl = `ws://127.0.0.1:${feed.address().port}`;
const report = [], children = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
async function waitFor(check, label, timeout = 40_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
function read(dbDir) {
  const db = new Database(path.join(dbDir, 'lightning.db'), { readonly: true });
  const scalar = query => db.prepare(query).get().n;
  const saved = db.prepare("SELECT value FROM counters WHERE key = 'trackedStorms'").get();
  const result = {
    total: Number(db.prepare("SELECT value FROM counters WHERE key = 'total'").get()?.value ?? 0),
    country: scalar('SELECT COALESCE(SUM(count),0) n FROM countries'), daily: scalar('SELECT COALESCE(SUM(count),0) n FROM daily_strikes'),
    journal: scalar('SELECT COUNT(*) n FROM strike_intake'), raw: scalar('SELECT COUNT(*) n FROM grid_strikes'),
    cells: scalar('SELECT COALESCE(SUM(total_strikes),0) n FROM grid_cells'), owned: scalar('SELECT COUNT(*) n FROM storm_replay_points'),
    storms: saved ? JSON.parse(saved.value).map(s => ({ key: s.key, total: s.totalStrikes, replay: s.allStrikes.length })) : [],
  };
  db.close(); return result;
}
async function boot(dbDir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--experimental-loader', './__tests__/fixtures/durabilityFeedLoader.mjs', 'server.mjs'], {
    cwd: root, env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DB_PATH: dbDir, DURABILITY_FEED_URL: feedUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child); let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(output);
      try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch { return false; }
    }, 'healthy production startup');
    const viewer = new WebSocket(`ws://127.0.0.1:${port}/ws`); let total = 0;
    viewer.on('message', message => { total = JSON.parse(message).total; }); await once(viewer, 'open');
    return { child, viewer, exited, total: () => total, output: () => output };
  } catch (error) { throw new Error(`${error.message}\n${output}`); }
}
async function stop(runtime, signal) {
  runtime.child.kill(signal);
  const timeout = setTimeout(() => runtime.child.kill('SIGKILL'), 15_000);
  const [code, endedSignal] = await runtime.exited;
  clearTimeout(timeout); runtime.viewer.terminate(); children.delete(runtime.child);
  if (signal === 'SIGTERM') assert.equal(code, 0, runtime.output()); else assert.equal(endedSignal, 'SIGKILL');
}
function send(points) {
  for (const client of feed.clients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ strokes: points }));
}
try {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const dbDir = path.join(temp, signal); fs.mkdirSync(dbDir);
    let runtime = await boot(dbDir);
    const now = Date.now();
    const points = Array.from({ length: 600 }, (_, i) => ({ lat: 45 + i % 20 * .001, lon: 12 + Math.floor(i / 20) * .001, time: now - 60_000 + i * 50 }));
    send(points);
    await waitFor(() => runtime.total() === 600, '600 accepted strikes', 4000);
    const before = read(dbDir);
    assert.equal(before.total, 0, 'terminate before the first 30s checkpoint');
    assert.equal(before.journal, 600, 'mirrors commit each physical strike only once');
    await stop(runtime, signal);
    const afterExit = read(dbDir);
    assert.equal(afterExit.total, signal === 'SIGTERM' ? 600 : 0, 'SIGKILL bypasses shutdown handlers');
    runtime = await boot(dbDir);
    await waitFor(() => runtime.total() === 600, 'recovered counter');
    const recovered = read(dbDir);
    for (const key of ['total', 'country', 'daily', 'raw', 'cells', 'owned']) assert.equal(recovered[key], 600, key);
    assert.equal(recovered.storms.length, 1); assert.equal(recovered.storms[0].total, 600); assert.equal(recovered.storms[0].replay, 600);
    send(points); await delay(1200); assert.equal(runtime.total(), 600, 'restart redelivery must not increase the counter');
    await stop(runtime, 'SIGTERM');
    const repeated = read(dbDir); assert.deepEqual(repeated, recovered);
    report.push({ signal, before, afterExit, recovered });
  }
  console.log(JSON.stringify({ tests: report }, null, 2));
} finally {
  for (const child of children) child.kill('SIGKILL');
  for (const client of feed.clients) client.terminate();
  await new Promise(resolve => feed.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
