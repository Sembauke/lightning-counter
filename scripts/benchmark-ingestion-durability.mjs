/** Run after npm run build. Isolated SQLite, actual production route and lookup. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-intake-benchmark-'));
process.env.DB_PATH = tmp;
const now = Date.now();
const ms = start => Number(process.hrtime.bigint() - start) / 1e6;
try {
  require(path.join(process.cwd(), '.next/server/app/api/strikes/route.js'));
  const samples = [];
  for (let i = 0; i < 3000; i++) {
    const start = process.hrtime.bigint();
    globalThis._processStrike(45 + i % 20 * .001, 12 + Math.floor(i / 20) * .001, now - 180_000 + i * 50);
    samples.push(ms(start));
  }
  samples.sort((a, b) => a - b);
  const ordinaryStart = process.hrtime.bigint(); globalThis._flushIngestion(); const ordinaryCheckpointMs = ms(ordinaryStart);
  const frames = [];
  for (let batch = 0; batch < 270; batch++) {
    const points = Array.from({ length: 100 }, (_, offset) => {
      const i = 3000 + batch * 100 + offset;
      return { lat: 45 + i % 20 * .001, lon: 12 + i % 500 * .001, time: now - 180_000 + i * 5 };
    });
    const start = process.hrtime.bigint(); globalThis._processStrikes(points); frames.push(ms(start));
  }
  const start = process.hrtime.bigint(); globalThis._flushIngestion(); const checkpointMs = ms(start);
  const query = new Database(path.join(tmp, 'lightning.db'), { readonly: true });
  const total = Number(query.prepare("SELECT value FROM counters WHERE key='total'").get().value);
  const journal = query.prepare('SELECT COUNT(*) n FROM strike_intake').get().n;
  assert.equal(total, 30000); assert.equal(journal, total); query.close();
  console.log(JSON.stringify({ total, journal, ordinaryCheckpointMs, singlePointFrames: { count: samples.length, meanMs: samples.reduce((a,b)=>a+b,0)/samples.length,
    p95Ms: samples[Math.floor(samples.length*.95)], maxMs: samples.at(-1) }, hundredPointFrames: {
    count: frames.length, meanMs: frames.reduce((a,b)=>a+b,0)/frames.length, maxMs: Math.max(...frames) }, checkpointMs }, null, 2));
} finally {
  for (const key of ['_iv_histPrune','_iv_dbFlush','_iv_gridBatch','_iv_hourly']) clearInterval(globalThis[key]);
  fs.rmSync(tmp, { recursive: true, force: true });
  // The database schedules unrelated one-time maintenance with setImmediate.
  process.exit();
}
