import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = process.env.DB_PATH ?? (fs.existsSync('/data') ? '/data' : './tmp');
const DB_FILE = path.join(DB_DIR, 'lightning.db');

let _db: Database.Database | null = null;

/** [lat, lon, epochMs] — compact form for the record storm's strike sample */
export type StormStrike = [number, number, number];

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
    CREATE TABLE IF NOT EXISTS country_peak_rates (
      code TEXT PRIMARY KEY,
      rate REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storms (
      storm_key TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      count INTEGER NOT NULL,
      rate REAL NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      city TEXT,
      date TEXT NOT NULL,
      origin_lat REAL,
      origin_lon REAL,
      origin_city TEXT,
      start_time INTEGER,
      end_time INTEGER,
      traveled_km REAL,
      total_count INTEGER,
      strikes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_storms_date_count ON storms(date, count DESC);
    CREATE INDEX IF NOT EXISTS idx_storms_code_date ON storms(code, date);
    CREATE TABLE IF NOT EXISTS storm_records (
      category TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      count INTEGER NOT NULL,
      rate REAL NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      city TEXT,
      date TEXT NOT NULL,
      origin_lat REAL,
      origin_lon REAL,
      origin_city TEXT,
      start_time INTEGER,
      end_time INTEGER,
      storm_key TEXT,
      traveled_km REAL,
      total_count INTEGER,
      strikes TEXT
    );
    CREATE TABLE IF NOT EXISTS country_biggest_storms (
      code TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      rate REAL NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      city TEXT,
      date TEXT NOT NULL,
      strikes TEXT
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
    CREATE INDEX IF NOT EXISTS idx_gs_time ON grid_strikes(strike_time);
    DELETE FROM grid_strikes WHERE strike_time < unixepoch('now', '-3 days') * 1000;
  `);
  // Migrations for databases created before the replay / storm-tracking features
  const migrations = [
    'ALTER TABLE country_biggest_storms ADD COLUMN strikes TEXT',
    'ALTER TABLE country_biggest_storms ADD COLUMN origin_lat REAL',
    'ALTER TABLE country_biggest_storms ADD COLUMN origin_lon REAL',
    'ALTER TABLE country_biggest_storms ADD COLUMN origin_city TEXT',
    'ALTER TABLE country_biggest_storms ADD COLUMN start_time INTEGER',
    'ALTER TABLE country_biggest_storms ADD COLUMN end_time INTEGER',
    'ALTER TABLE country_biggest_storms ADD COLUMN storm_key TEXT',
    'ALTER TABLE country_biggest_storms ADD COLUMN traveled_km REAL',
    'ALTER TABLE country_biggest_storms ADD COLUMN total_count INTEGER',
  ];
  for (const m of migrations) {
    try { _db.exec(m); } catch { /* column exists */ }
  }

  // One-time sanitation: before strike times flowed through the pipeline,
  // reconnect backlogs were stamped with a single arrival time, minting
  // impossible records (e.g. "993/min") that block genuine storms forever.
  try {
    const rows = _db.prepare('SELECT code, strikes FROM country_biggest_storms WHERE strikes IS NOT NULL')
      .all() as Array<{ code: string; strikes: string }>;
    const del = _db.prepare('DELETE FROM country_biggest_storms WHERE code = ?');
    for (const row of rows) {
      try {
        if (hasTimestampBurst(JSON.parse(row.strikes))) del.run(row.code);
      } catch { del.run(row.code); }
    }
  } catch { /* best-effort */ }
  return _db;
}

/**
 * True when an implausible share of strikes lands in a single second — the
 * signature of an ingestion backlog flush, not a real storm.
 */
export function hasTimestampBurst(points: StormStrike[]): boolean {
  if (points.length < 50) return false;
  const perSecond = new Map<number, number>();
  let max = 0;
  for (const p of points) {
    const k = Math.floor(p[2] / 1000);
    const n = (perSecond.get(k) ?? 0) + 1;
    perSecond.set(k, n);
    if (n > max) max = n;
  }
  return max > points.length * 0.2;
}

// The startup DELETE above only runs once per process — a long-running server
// needs this called periodically or grid_strikes grows without bound
export function pruneGridStrikes(): void {
  const db = getDb();
  db.prepare('DELETE FROM grid_strikes WHERE strike_time < ?').run(Date.now() - 3 * 24 * 60 * 60 * 1000);
  db.pragma('wal_checkpoint(TRUNCATE)');
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

export function getCountryPeakRates(): Array<{ code: string; rate: number }> {
  const db = getDb();
  return db.prepare('SELECT code, rate FROM country_peak_rates').all() as Array<{ code: string; rate: number }>;
}

export function upsertCountryPeakRates(rates: Record<string, number>): void {
  if (Object.keys(rates).length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    'INSERT INTO country_peak_rates (code, rate) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET rate = excluded.rate WHERE excluded.rate > rate'
  );
  db.transaction(() => {
    for (const [code, rate] of Object.entries(rates)) stmt.run(code, rate);
  })();
}


export interface BiggestStorm {
  code: string;
  count: number;   // strikes in the storm's best 5-min window
  rate: number;    // strikes per minute at that peak
  lat: number;     // current/last-tracked centroid
  lon: number;
  city: string | null;
  date: string;
  originLat: number | null;   // where the storm first crossed the threshold
  originLon: number | null;
  originCity: string | null;
  startTime: number | null;   // first tracked strike (epoch ms)
  endTime: number | null;     // last time it was seen above the threshold
  stormKey: string | null;    // identity across tracker passes
  traveledKm: number | null;  // cumulative centroid path length
  totalCount: number | null;  // strikes over the storm's whole tracked life
  strikes: StormStrike[] | null;
}

export function getBiggestStorm(code: string): BiggestStorm | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT code, count, rate, lat, lon, city, date,
           origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
           start_time AS startTime, end_time AS endTime, storm_key AS stormKey,
           traveled_km AS traveledKm, total_count AS totalCount, strikes
    FROM country_biggest_storms WHERE code = ?
  `).get(code) as (Omit<BiggestStorm, 'strikes'> & { strikes: string | null }) | undefined;
  if (!row) return null;
  let strikes: StormStrike[] | null = null;
  try { strikes = row.strikes ? JSON.parse(row.strikes) : null; } catch { /* corrupt — treat as absent */ }
  return { ...row, strikes };
}

export function upsertBiggestStorms(storms: BiggestStorm[]): void {
  if (storms.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO country_biggest_storms
      (code, count, rate, lat, lon, city, date,
       origin_lat, origin_lon, origin_city, start_time, end_time, storm_key,
       traveled_km, total_count, strikes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      count = excluded.count, rate = excluded.rate, lat = excluded.lat,
      lon = excluded.lon, city = excluded.city, date = excluded.date,
      origin_lat = excluded.origin_lat, origin_lon = excluded.origin_lon,
      origin_city = excluded.origin_city, start_time = excluded.start_time,
      end_time = excluded.end_time, storm_key = excluded.storm_key,
      traveled_km = excluded.traveled_km, total_count = excluded.total_count,
      strikes = excluded.strikes
    WHERE excluded.count > count
      -- the record-holding storm keeps updating its own row while it lives
      -- (path end point, end time, growing peak)
      OR (excluded.storm_key IS NOT NULL AND excluded.storm_key = storm_key)
      -- transition: records saved before the replay feature have no strikes;
      -- let the next qualifying storm claim them so the map can appear
      OR strikes IS NULL
  `);
  db.transaction(() => {
    for (const s of storms) {
      stmt.run(s.code, s.count, s.rate, s.lat, s.lon, s.city, s.date,
        s.originLat, s.originLon, s.originCity, s.startTime, s.endTime, s.stormKey,
        s.traveledKm, s.totalCount, s.strikes ? JSON.stringify(s.strikes) : null);
    }
  })();
}

// ── Global storm hall of fame ───────────────────────────────────────────
export type StormRecordCategory = 'biggest' | 'longest' | 'farthest' | 'fastest';

export interface GlobalStormRecord extends BiggestStorm {
  category: StormRecordCategory;
}

const RECORD_METRICS: Record<StormRecordCategory, (s: BiggestStorm) => number | null> = {
  biggest: s => s.count,
  longest: s => (s.startTime != null && s.endTime != null ? s.endTime - s.startTime : null),
  farthest: s => (s.traveledKm != null && s.traveledKm >= 5 ? s.traveledKm : null),
  // km/h over the storm's life; short or barely-moving storms aren't eligible
  fastest: s => {
    if (s.traveledKm == null || s.startTime == null || s.endTime == null) return null;
    const hours = (s.endTime - s.startTime) / 3_600_000;
    if (s.traveledKm < 20 || hours < 1 / 6) return null;
    return s.traveledKm / hours;
  },
};

export function getStormRecords(): GlobalStormRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT category, code, count, rate, lat, lon, city, date,
           origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
           start_time AS startTime, end_time AS endTime, storm_key AS stormKey,
           traveled_km AS traveledKm, total_count AS totalCount, strikes
    FROM storm_records
  `).all() as Array<Omit<GlobalStormRecord, 'strikes'> & { strikes: string | null }>;
  return rows.map(row => {
    let strikes: StormStrike[] | null = null;
    try { strikes = row.strikes ? JSON.parse(row.strikes) : null; } catch { /* corrupt */ }
    return { ...row, strikes };
  });
}

/** Offer this pass's storms as hall-of-fame candidates for every category */
export function upsertStormRecords(candidates: BiggestStorm[]): void {
  if (candidates.length === 0) return;
  const db = getDb();
  const current = new Map(getStormRecords().map(r => [r.category, r]));
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO storm_records
      (category, code, count, rate, lat, lon, city, date,
       origin_lat, origin_lon, origin_city, start_time, end_time, storm_key,
       traveled_km, total_count, strikes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const category of Object.keys(RECORD_METRICS) as StormRecordCategory[]) {
      const metric = RECORD_METRICS[category];
      let holder = current.get(category) ?? null;
      for (const s of candidates) {
        const value = metric(s);
        if (value == null) continue;
        // The record-holding storm refreshes its own entry as it lives on;
        // challengers must beat the stored metric
        const sameStorm = holder?.stormKey != null && holder.stormKey === s.stormKey;
        const holderValue = holder ? metric(holder) : null;
        if (sameStorm || holderValue == null || value > holderValue) {
          holder = { ...s, category };
        }
      }
      if (holder && holder !== current.get(category)) {
        stmt.run(category, holder.code, holder.count, holder.rate, holder.lat, holder.lon,
          holder.city, holder.date, holder.originLat, holder.originLon, holder.originCity,
          holder.startTime, holder.endTime, holder.stormKey, holder.traveledKm,
          holder.totalCount, holder.strikes ? JSON.stringify(holder.strikes) : null);
      }
    }
  })();
}

// ── Storm history log ──────────────────────────────────────────────────
/** Metadata-only storm row for day listings (strikes fetched separately) */
export type StormLogRow = Omit<BiggestStorm, 'strikes'> & { stormKey: string };

/** Keep every tracked storm's latest state; rows persist after the storm dies */
export function upsertStorms(storms: BiggestStorm[]): void {
  if (storms.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO storms
      (storm_key, code, count, rate, lat, lon, city, date,
       origin_lat, origin_lon, origin_city, start_time, end_time,
       traveled_km, total_count, strikes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const s of storms) {
      if (!s.stormKey) continue;
      stmt.run(s.stormKey, s.code, s.count, s.rate, s.lat, s.lon, s.city, s.date,
        s.originLat, s.originLon, s.originCity, s.startTime, s.endTime,
        s.traveledKm, s.totalCount, s.strikes ? JSON.stringify(s.strikes) : null);
    }
  })();
}

export function getStormsForDate(date: string, code?: string): StormLogRow[] {
  const db = getDb();
  const base = `
    SELECT storm_key AS stormKey, code, count, rate, lat, lon, city, date,
           origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
           start_time AS startTime, end_time AS endTime,
           traveled_km AS traveledKm, total_count AS totalCount
    FROM storms WHERE date = ?`;
  return (code
    ? db.prepare(`${base} AND code = ? ORDER BY count DESC`).all(date, code)
    : db.prepare(`${base} ORDER BY count DESC`).all(date)) as StormLogRow[];
}

export function getStormByKey(stormKey: string): BiggestStorm | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT storm_key AS stormKey, code, count, rate, lat, lon, city, date,
           origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
           start_time AS startTime, end_time AS endTime,
           traveled_km AS traveledKm, total_count AS totalCount, strikes
    FROM storms WHERE storm_key = ?
  `).get(stormKey) as (Omit<BiggestStorm, 'strikes'> & { strikes: string | null }) | undefined;
  if (!row) return null;
  let strikes: StormStrike[] | null = null;
  try { strikes = row.strikes ? JSON.parse(row.strikes) : null; } catch { /* corrupt */ }
  return { ...row, strikes };
}

/** Strike samples are heavy — keep them 7 days; storm metadata stays forever */
export function pruneStormStrikes(): void {
  const db = getDb();
  db.prepare('UPDATE storms SET strikes = NULL WHERE strikes IS NOT NULL AND end_time < ?')
    .run(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

export function getTopDailyPeak(): { code: string; count: number; date: string } | null {
  const db = getDb();
  const row = db.prepare('SELECT code, count, date FROM country_peaks ORDER BY count DESC LIMIT 1')
    .get() as { code: string; count: number; date: string } | undefined;
  return row ?? null;
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
  // INDEXED BY: the planner picks idx_gs_latlon for wide viewports, which visits
  // every row in the lat range and sorts (seconds on a big table). The time index
  // walks newest-first and stops at `since` — the 30-min window keeps it tiny.
  return db.prepare(
    `SELECT lat, lon, strike_time FROM grid_strikes INDEXED BY idx_gs_time
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
