import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = process.env.DB_PATH ?? (fs.existsSync('/data') ? '/data' : './tmp');
const DB_FILE = path.join(DB_DIR, 'lightning.db');

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_FILE);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('cache_size = -8000'); // 8MB page cache
  _db.exec(`
    CREATE TABLE IF NOT EXISTS counters (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS countries (
      code  TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS daily_strikes (
      date TEXT NOT NULL,
      code TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, code)
    );
    CREATE TABLE IF NOT EXISTS country_peaks (
      code TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grid_cells (
      cell_id TEXT PRIMARY KEY,
      total_strikes INTEGER NOT NULL DEFAULT 0,
      last_strike_time INTEGER
    );
    CREATE TABLE IF NOT EXISTS grid_strikes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cell_id TEXT NOT NULL,
      strike_time INTEGER NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gs_cell_time ON grid_strikes(cell_id, strike_time DESC);
    CREATE INDEX IF NOT EXISTS idx_gs_latlon ON grid_strikes(lat, lon);
    DELETE FROM grid_strikes WHERE strike_time < unixepoch('now', '-7 days') * 1000;
  `);
  return _db;
}

export function loadCounters(): { total: number; countries: Record<string, number> } {
  const db = getDb();
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get('total') as { value: string } | undefined;
  const total = row ? (parseInt(row.value, 10) || 0) : 0;

  const rows = db.prepare('SELECT code, count FROM countries').all() as { code: string; count: number }[];
  const countries: Record<string, number> = {};
  for (const r of rows) countries[r.code] = r.count;

  return { total, countries };
}

export function loadDailyStrikes(date: string): Record<string, number> {
  const db = getDb();
  const rows = db.prepare('SELECT code, count FROM daily_strikes WHERE date = ?').all(date) as { code: string; count: number }[];
  const result: Record<string, number> = {};
  for (const r of rows) result[r.code] = r.count;
  return result;
}

export function getCountryPeaks(): Array<{ code: string; count: number; date: string }> {
  const db = getDb();
  return db.prepare('SELECT code, count, date FROM country_peaks ORDER BY count DESC').all() as Array<{ code: string; count: number; date: string }>;
}

export function getCountryHistory(code: string): Array<{ date: string; count: number }> {
  const db = getDb();
  return db.prepare('SELECT date, count FROM daily_strikes WHERE code = ? ORDER BY date DESC').all(code) as Array<{ date: string; count: number }>;
}

const _upsertTotal = () => getDb().prepare('INSERT OR REPLACE INTO counters (key, value) VALUES (?, ?)');
const _upsertCountry = () => getDb().prepare('INSERT INTO countries (code, count) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET count = excluded.count');

export function saveCounters(total: number, countries: Record<string, number>): void {
  const db = getDb();
  const upsertTotal = _upsertTotal();
  const upsertCountry = _upsertCountry();

  db.transaction(() => {
    upsertTotal.run('total', String(total));
    for (const [code, count] of Object.entries(countries)) {
      upsertCountry.run(code, count);
    }
  })();
}

export function saveDailyAndPeaks(date: string, daily: Record<string, number>): void {
  if (Object.keys(daily).length === 0) return;
  const db = getDb();
  const upsertDaily = db.prepare('INSERT INTO daily_strikes (date, code, count) VALUES (?, ?, ?) ON CONFLICT(date, code) DO UPDATE SET count = excluded.count');
  const upsertPeak = db.prepare('INSERT INTO country_peaks (code, count, date) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET count = excluded.count, date = excluded.date WHERE excluded.count > count');

  db.transaction(() => {
    for (const [code, count] of Object.entries(daily)) {
      if (count > 0) {
        upsertDaily.run(date, code, count);
        upsertPeak.run(code, count, date);
      }
    }
  })();
}

const FIXED_BIN_ZOOM = 9;
const FIXED_DISPLAY_PX = 24;

function serverProject(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const scale = 256 * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

export function latLonToCellId(lat: number, lon: number): string {
  const p = serverProject(lat, lon, FIXED_BIN_ZOOM);
  const col = Math.floor(p.x / FIXED_DISPLAY_PX);
  const row = Math.floor(p.y / FIXED_DISPLAY_PX);
  return `${col},${row}`;
}

export function archiveGridStrikeBatch(strikes: Array<{ lat: number; lon: number; time: number }>): void {
  if (strikes.length === 0) return;
  const db = getDb();
  const insertStrike = db.prepare(`INSERT INTO grid_strikes (cell_id, strike_time, lat, lon) VALUES (?, ?, ?, ?)`);
  const upsertCell = db.prepare(`
    INSERT INTO grid_cells (cell_id, total_strikes, last_strike_time)
    VALUES (?, 1, ?)
    ON CONFLICT(cell_id) DO UPDATE SET
      total_strikes = total_strikes + 1,
      last_strike_time = MAX(last_strike_time, excluded.last_strike_time)
  `);
  db.transaction(() => {
    for (const { lat, lon, time } of strikes) {
      const cellId = latLonToCellId(lat, lon);
      insertStrike.run(cellId, time, lat, lon);
      upsertCell.run(cellId, time);
    }
  })();
}

export function getGridCellPage(
  cellId: string,
  page: number,
  limit: number
): {
  cell: { cell_id: string; total_strikes: number; last_strike_time: number } | null;
  strikes: Array<{ id: number; strike_time: number; lat: number; lon: number }>;
  total: number;
} {
  const db = getDb();
  const cell = db.prepare('SELECT cell_id, total_strikes, last_strike_time FROM grid_cells WHERE cell_id = ?').get(cellId) as
    | { cell_id: string; total_strikes: number; last_strike_time: number }
    | undefined;
  if (!cell) return { cell: null, strikes: [], total: 0 };
  const offset = (page - 1) * limit;
  const strikes = db.prepare(
    'SELECT id, strike_time, lat, lon FROM grid_strikes WHERE cell_id = ? ORDER BY strike_time DESC LIMIT ? OFFSET ?'
  ).all(cellId, limit, offset) as Array<{ id: number; strike_time: number; lat: number; lon: number }>;
  return { cell, strikes, total: cell.total_strikes };
}

export function getViewportStrikes(
  minLat: number, maxLat: number, minLon: number, maxLon: number,
  since: number, limit = 20_000
): Array<{ lat: number; lon: number; strike_time: number }> {
  const db = getDb();
  return db.prepare(
    `SELECT lat, lon, strike_time FROM grid_strikes
     WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND strike_time >= ?
     ORDER BY strike_time DESC LIMIT ?`
  ).all(minLat, maxLat, minLon, maxLon, since, limit) as Array<{ lat: number; lon: number; strike_time: number }>;
}

export function getGridAreaPage(
  minLat: number, maxLat: number, minLon: number, maxLon: number,
  page: number, limit: number
): { strikes: Array<{ id: number; strike_time: number; lat: number; lon: number }>; total: number } {
  const db = getDb();
  const { n } = db.prepare(
    'SELECT COUNT(*) as n FROM grid_strikes WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?'
  ).get(minLat, maxLat, minLon, maxLon) as { n: number };
  const offset = (page - 1) * limit;
  const strikes = db.prepare(
    'SELECT id, strike_time, lat, lon FROM grid_strikes WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? ORDER BY strike_time DESC LIMIT ? OFFSET ?'
  ).all(minLat, maxLat, minLon, maxLon, limit, offset) as Array<{ id: number; strike_time: number; lat: number; lon: number }>;
  return { strikes, total: n };
}
