import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const now = Date.UTC(2001, 0, 4, 12, 34, 56, 789);
const retention = 3 * 24 * 60 * 60_000;
const cutoff = now - retention;
const originalPath = process.env.DB_PATH;
let directory: string;
let sql: Database.Database;
let db: typeof import('../app/lib/db');

async function restart() {
  vi.resetModules();
  db = await import('../app/lib/db');
  db.loadCounters();
  // Let the unrelated one-time startup repairs finish before closing fixtures.
  await new Promise<void>(resolve => setImmediate(resolve));
}

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-grid-retention-clock-'));
  process.env.DB_PATH = directory;
  await restart();
  sql = new Database(path.join(directory, 'lightning.db'));
});

afterEach(() => {
  sql?.close();
  vi.restoreAllMocks();
  if (originalPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

function expectRetained(times: number[]) {
  for (const table of ['grid_strikes', 'storm_replay_points']) {
    expect(sql.prepare(`SELECT strike_time FROM ${table} ORDER BY strike_time`).all())
      .toEqual(times.map(strike_time => ({ strike_time })));
  }
  expect(sql.prepare('SELECT total_strikes, last_strike_time FROM grid_cells WHERE cell_id = ?').get('retention'))
    .toEqual({ total_strikes: 4, last_strike_time: now });
}

it('uses the same millisecond cutoff on startup and maintenance without changing lifetime cell totals', async () => {
  const times = [cutoff - 1, cutoff, cutoff + 1, now];
  const insertRaw = sql.prepare('INSERT INTO grid_strikes(cell_id, strike_time, lat, lon) VALUES (?, ?, 45, 12)');
  const insertOwned = sql.prepare('INSERT INTO storm_replay_points(storm_key, strike_time, lat_milli, lon_milli) VALUES (?, ?, 45000, 12000)');
  sql.transaction(() => {
    for (const time of times) {
      insertRaw.run('retention', time);
      insertOwned.run('retention-storm', time);
    }
    sql.prepare('INSERT INTO grid_cells(cell_id, total_strikes, last_strike_time) VALUES (?, ?, ?)')
      .run('retention', times.length, now);
  })();
  expectRetained(times);

  // SQLite's independent wall clock would wrongly erase this entire fixture.
  // The 789 ms offset also catches rounding the application cutoff to seconds.
  await restart();
  expectRetained([cutoff, cutoff + 1, now]);
  db.pruneGridStrikes();
  expectRetained([cutoff, cutoff + 1, now]);

  vi.mocked(Date.now).mockReturnValue(now + 1);
  db.pruneGridStrikes();
  expectRetained([cutoff + 1, now]);

  vi.mocked(Date.now).mockReturnValue(now + 2);
  await restart();
  expectRetained([now]);
});
