import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { recoverOwnedReplay } from './stormReplayRecovery';
import { selectStormReplaySnapshot } from './stormReplaySnapshot';

const DB_DIR = process.env.DB_PATH ?? (fs.existsSync('/data') ? '/data' : './tmp');
const DB_FILE = path.join(DB_DIR, 'lightning.db');
const GRID_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

let _db: Database.Database | null = null;

/** [lat, lon, epochMs] — compact form for the record storm's strike sample */
export type StormStrike = [number, number, number];

function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_FILE);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = FULL'); // Accepted intake must survive a process exit before its checkpoint.
  _db.pragma('cache_size = -8000'); // 8MB page cache
  _db.exec(`
    CREATE TABLE IF NOT EXISTS counters (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strike_intake (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity TEXT NOT NULL UNIQUE,
      received_at INTEGER NOT NULL,
      strike_time INTEGER NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      cc TEXT,
      count_date TEXT NOT NULL,
      live INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_intake_archive ON strike_intake(archived, id);
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
    CREATE INDEX IF NOT EXISTS idx_daily_strikes_code_date ON daily_strikes(code, date);
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
      strikes TEXT,
      country_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_storms_date_count ON storms(date, count DESC);
    CREATE INDEX IF NOT EXISTS idx_storms_code_date ON storms(code, date);
    CREATE INDEX IF NOT EXISTS idx_storms_start_time ON storms(start_time);
    CREATE INDEX IF NOT EXISTS idx_storms_count ON storms(count DESC);
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
      strikes TEXT,
      country_path TEXT
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
    CREATE TABLE IF NOT EXISTS storm_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      storm_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      ts INTEGER NOT NULL,
      related_key TEXT,
      related_city TEXT,
      related_cc TEXT,
      strikes_absorbed INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_storm_events_key ON storm_events(storm_key, ts DESC);
    CREATE TABLE IF NOT EXISTS storm_aliases (
      alias_key TEXT PRIMARY KEY,
      canonical_key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storm_replay_points (
      storm_key TEXT NOT NULL,
      strike_time INTEGER NOT NULL,
      lat_milli INTEGER NOT NULL,
      lon_milli INTEGER NOT NULL,
      PRIMARY KEY (storm_key, strike_time, lat_milli, lon_milli)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_storm_replay_points_time ON storm_replay_points(strike_time);
  `);
  _db.prepare('DELETE FROM storm_replay_points WHERE strike_time < ?').run(Date.now() - GRID_RETENTION_MS);
  // Migrations for databases created before the replay / storm-tracking features
  const migrations = [
    'ALTER TABLE storms ADD COLUMN country_path TEXT',
    'ALTER TABLE storm_records ADD COLUMN country_path TEXT',
    'ALTER TABLE country_biggest_storms ADD COLUMN country_path TEXT',
    'ALTER TABLE country_biggest_storms ADD COLUMN strikes TEXT',
    'ALTER TABLE country_biggest_storms ADD COLUMN origin_lat REAL',
    'ALTER TABLE country_biggest_storms ADD COLUMN origin_lon REAL',
    'ALTER TABLE country_biggest_storms ADD COLUMN origin_city TEXT',
    'ALTER TABLE country_biggest_storms ADD COLUMN start_time INTEGER',
    'ALTER TABLE country_biggest_storms ADD COLUMN end_time INTEGER',
    'ALTER TABLE country_biggest_storms ADD COLUMN storm_key TEXT',
    'ALTER TABLE country_biggest_storms ADD COLUMN traveled_km REAL',
    'ALTER TABLE country_biggest_storms ADD COLUMN total_count INTEGER',
    'ALTER TABLE storm_events ADD COLUMN fragment_label TEXT',
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

  // Seed the 'most' record category from historical storms (one-time, on first boot
  // after the category was added). Only touches this one row — does not rebuild others.
  try {
    const v3 = _db.prepare('SELECT value FROM counters WHERE key = ?').get('repair_v3_done') as { value: string } | undefined;
    if (!v3) {
      setImmediate(() => {
        try {
          const db = getDb();
          const best = db.prepare(`
            SELECT storm_key AS stormKey, code, count, rate, lat, lon, city, date,
                   origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
                   start_time AS startTime, end_time AS endTime,
                   traveled_km AS traveledKm, total_count AS totalCount,
                   strikes, country_path AS countryPath
            FROM storms
            WHERE storm_key IS NOT NULL
            ORDER BY COALESCE(total_count, count) DESC
            LIMIT 1
          `).get() as (Omit<BiggestStorm, 'strikes' | 'countryPath'> & { stormKey: string; strikes: string | null; countryPath: string | null }) | undefined;
          if (best) {
            db.prepare(`
              INSERT OR IGNORE INTO storm_records
                (category, code, count, rate, lat, lon, city, date,
                 origin_lat, origin_lon, origin_city, start_time, end_time, storm_key,
                 traveled_km, total_count, strikes, country_path)
              VALUES ('most', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              best.code, best.count, best.rate, best.lat, best.lon, best.city, best.date,
              best.originLat, best.originLon, best.originCity, best.startTime, best.endTime,
              best.stormKey, best.traveledKm, best.totalCount, best.strikes, best.countryPath,
            );
          }
          db.prepare('INSERT OR REPLACE INTO counters (key, value) VALUES (?, ?)').run('repair_v3_done', '1');
        } catch { /* non-fatal */ }
      });
    }
  } catch { /* non-fatal */ }

  // One-time repair for storms recorded before two duplicate-counting bugs were
  // fixed: lightningmaps resent every stroke 2-4x under fresh ids (server.mjs
  // dedup keyed on the meaningless id instead of the physical strike), and
  // flapping split/merge cycles re-concatenated the same points into a storm's
  // strikes blob on every cycle (absorbInto had no overlap check for the blob,
  // only for the numeric counter). Runs once on the first boot after the fix.
  try {
    const dedupeDone = _db.prepare('SELECT value FROM counters WHERE key = ?').get('dedupe_strike_totals_v1_done') as { value: string } | undefined;
    if (!dedupeDone) {
      setImmediate(() => {
        try {
          const db = getDb();
          const result = recalculateDuplicateStormTotals();
          console.log(`[db] duplicate-strike repair: corrected ${result.storms} storms, ${result.countryBiggest} country-biggest entries`);
          db.prepare('INSERT OR REPLACE INTO counters (key, value) VALUES (?, ?)').run('dedupe_strike_totals_v1_done', '1');
        } catch (err) { console.error('[db] duplicate-strike repair failed:', err); }
      });
    }
  } catch { /* non-fatal */ }

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
  const cutoff = Date.now() - GRID_RETENTION_MS;
  db.transaction(() => {
    db.prepare('DELETE FROM grid_strikes WHERE strike_time < ?').run(cutoff);
    db.prepare('DELETE FROM storm_replay_points WHERE strike_time < ?').run(cutoff);
  })();
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

export function getCountryPeak(code: string): { count: number; date: string } | null {
  const db = getDb();
  return db.prepare('SELECT count, date FROM country_peaks WHERE code = ?').get(code) as { count: number; date: string } | undefined ?? null;
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
  countryPath: string[] | null; // ordered country codes the storm passed through
}

export function getBiggestStorm(code: string): BiggestStorm | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT code, count, rate, lat, lon, city, date,
           origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
           start_time AS startTime, end_time AS endTime, storm_key AS stormKey,
           traveled_km AS traveledKm, total_count AS totalCount, strikes, country_path AS countryPath
    FROM country_biggest_storms WHERE code = ?
  `).get(code) as (Omit<BiggestStorm, 'strikes' | 'countryPath'> & { strikes: string | null; countryPath: string | null }) | undefined;
  if (!row) return null;
  let strikes: StormStrike[] | null = null;
  try { strikes = row.strikes ? JSON.parse(row.strikes) : null; } catch { /* corrupt — treat as absent */ }
  let countryPath: string[] | null = null;
  try { countryPath = row.countryPath ? JSON.parse(row.countryPath) : null; } catch { /* ignore */ }
  return { ...row, strikes, countryPath };
}

export function upsertBiggestStorms(storms: BiggestStorm[]): void {
  if (storms.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO country_biggest_storms
      (code, count, rate, lat, lon, city, date,
       origin_lat, origin_lon, origin_city, start_time, end_time, storm_key,
       traveled_km, total_count, strikes, country_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      count = excluded.count, rate = excluded.rate, lat = excluded.lat,
      lon = excluded.lon, city = excluded.city, date = excluded.date,
      origin_lat = excluded.origin_lat, origin_lon = excluded.origin_lon,
      origin_city = excluded.origin_city, start_time = excluded.start_time,
      end_time = excluded.end_time, storm_key = excluded.storm_key,
      traveled_km = excluded.traveled_km, total_count = excluded.total_count,
      strikes = excluded.strikes, country_path = excluded.country_path
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
        s.traveledKm, s.totalCount, s.strikes ? JSON.stringify(s.strikes) : null,
        s.countryPath ? JSON.stringify(s.countryPath) : null);
    }
  })();
}

// ── Global storm hall of fame ───────────────────────────────────────────
export type StormRecordCategory = 'biggest' | 'longest' | 'farthest' | 'most';

export interface GlobalStormRecord extends BiggestStorm {
  category: StormRecordCategory;
}

const RECORD_METRICS: Record<StormRecordCategory, (s: BiggestStorm) => number | null> = {
  biggest: s => (s.totalCount != null && s.totalCount > 0 ? s.totalCount : s.count),
  longest: s => (s.startTime != null && s.endTime != null ? s.endTime - s.startTime : null),
  farthest: s => (s.traveledKm != null && s.traveledKm >= 5 ? s.traveledKm : null),
  most:    s => (s.totalCount != null && s.totalCount > 0 ? s.totalCount : s.count),
};

export function getStormRecords(): GlobalStormRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT category, code, count, rate, lat, lon, city, date,
           origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
           start_time AS startTime, end_time AS endTime, storm_key AS stormKey,
           traveled_km AS traveledKm, total_count AS totalCount, strikes,
           country_path AS countryPath
    FROM storm_records
    WHERE category != 'most'
  `).all() as Array<Omit<GlobalStormRecord, 'strikes' | 'countryPath'> & { strikes: string | null; countryPath: string | null }>;
  return rows.map(row => {
    let strikes: StormStrike[] | null = null;
    try { strikes = row.strikes ? JSON.parse(row.strikes) : null; } catch { /* corrupt */ }
    let countryPath: string[] | null = null;
    try { countryPath = row.countryPath ? JSON.parse(row.countryPath) : null; } catch { /* ignore */ }
    return { ...row, strikes, countryPath };
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
       traveled_km, total_count, strikes, country_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          holder.totalCount, holder.strikes ? JSON.stringify(holder.strikes) : null,
          holder.countryPath ? JSON.stringify(holder.countryPath) : null);
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
  const readReplay = db.prepare('SELECT strikes FROM storms WHERE storm_key = ?');
  const stmt = db.prepare(`
    INSERT INTO storms
      (storm_key, code, count, rate, lat, lon, city, date,
       origin_lat, origin_lon, origin_city, start_time, end_time,
       traveled_km, total_count, strikes, country_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(storm_key) DO UPDATE SET
      code = excluded.code, count = excluded.count, rate = excluded.rate,
      lat = excluded.lat, lon = excluded.lon, city = excluded.city, date = excluded.date,
      origin_lat = excluded.origin_lat, origin_lon = excluded.origin_lon,
      origin_city = excluded.origin_city, start_time = excluded.start_time,
      end_time = excluded.end_time, traveled_km = excluded.traveled_km,
      total_count = excluded.total_count,
      strikes = excluded.strikes,
      country_path = excluded.country_path
  `);
  db.transaction(() => {
    for (const s of storms) {
      if (!s.stormKey) continue;
      const existing = readReplay.get(s.stormKey) as { strikes: string | null } | undefined;
      const replay = selectReplayJson(existing?.strikes ?? null, s.strikes);
      stmt.run(s.stormKey, s.code, s.count, s.rate, s.lat, s.lon, s.city, s.date,
        s.originLat, s.originLon, s.originCity, s.startTime, s.endTime,
        s.traveledKm, s.totalCount, replay,
        s.countryPath ? JSON.stringify(s.countryPath) : null);
    }
  })();
}

function selectReplayJson(storedJson: string | null, incoming: StormStrike[] | null): string | null {
  let stored: StormStrike[] | null = null;
  try {
    const parsed = storedJson ? JSON.parse(storedJson) : null;
    if (Array.isArray(parsed)) stored = parsed;
  } catch { /* A valid incoming sample can replace a corrupt replay. */ }
  const selected = selectStormReplaySnapshot(stored, incoming);
  if (selected === stored) return storedJson;
  return selected ? JSON.stringify(selected) : null;
}

/** Persist fading lightning without extending the qualified storm's metrics. */
export function updateStormReplay(stormKey: string, strikes: StormStrike[]): void {
  const db = getDb();
  db.transaction(() => {
    // UPDATE only: a replay continuation must not create a log entry, claim a
    // record, or resurrect a key that the tracker has absorbed into another one.
    for (const table of ['storms', 'country_biggest_storms', 'storm_records']) {
      const copies = db.prepare(`SELECT rowid, strikes FROM ${table} WHERE storm_key = ?`).all(stormKey) as Array<{ rowid: number; strikes: string | null }>;
      const update = db.prepare(`UPDATE ${table} SET strikes = ? WHERE rowid = ?`);
      for (const copy of copies) update.run(selectReplayJson(copy.strikes, strikes), copy.rowid);
    }
  })();
}

function parseCountryPath(raw: string | null): string[] | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as string[]; } catch { return null; }
}

export function getStormsForDate(date: string, code?: string): StormLogRow[] {
  const db = getDb();
  const base = `
    SELECT storm_key AS stormKey, code, count, rate, lat, lon, city, date,
           origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
           start_time AS startTime, end_time AS endTime,
           traveled_km AS traveledKm, total_count AS totalCount,
           country_path AS countryPath
    FROM storms WHERE date = ? AND COALESCE(total_count, count) >= 5000`;
  const rows = (code
    ? db.prepare(`${base} AND code = ? ORDER BY end_time DESC, start_time DESC`).all(date, code)
    : db.prepare(`${base} ORDER BY end_time DESC, start_time DESC`).all(date)) as (Omit<StormLogRow, 'countryPath'> & { countryPath: string | null })[];
  return rows.map(r => ({ ...r, countryPath: parseCountryPath(r.countryPath) }));
}

/** All currently-active storms (end_time within last 10 min), any size, any date — for map rank matching */
/** Returns all storm_keys currently in the storms table — used to validate links before broadcasting */
export function getTrackedStormKeys(): Set<string> {
  const db = getDb();
  const rows = db.prepare('SELECT storm_key FROM storms WHERE storm_key IS NOT NULL').all() as Array<{ storm_key: string }>;
  return new Set(rows.map(r => r.storm_key));
}

export function getLiveStorms(): Array<{ stormKey: string; lat: number; lon: number; totalCount: number | null; count: number }> {
  const db = getDb();
  const cutoff = Date.now() - 10 * 60 * 1000;
  return db.prepare(`
    SELECT storm_key AS stormKey, lat, lon, total_count AS totalCount, count
    FROM storms WHERE end_time >= ?
    ORDER BY COALESCE(total_count, count) DESC
  `).all(cutoff) as Array<{ stormKey: string; lat: number; lon: number; totalCount: number | null; count: number }>;
}

/**
 * Best storm per calendar date, ordered newest-first, for the records page
 * timeline. The per-day winner is picked by total_count (matching how
 * "biggest" is defined everywhere else — the Top 100 list, pruneStormStrikes'
 * protection query, the storm_records 'biggest' category — not the day's
 * peak 5-minute burst, which is a different, unrelated storm more often than
 * not). The outer ORDER BY is chronological (this is a day-by-day timeline,
 * not a magnitude ranking — "Top 100 all time" already covers that view).
 */
export function getBiggestStormPerDay(): StormLogRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT stormKey, code, count, rate, lat, lon, city, date,
           originLat, originLon, originCity, startTime, endTime,
           traveledKm, totalCount, countryPath
    FROM (
      SELECT storm_key AS stormKey, code, count, rate, lat, lon, city, date,
             origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
             start_time AS startTime, end_time AS endTime,
             traveled_km AS traveledKm, total_count AS totalCount,
             country_path AS countryPath,
             ROW_NUMBER() OVER (PARTITION BY date ORDER BY COALESCE(total_count, count) DESC) AS rn
      FROM storms
    )
    WHERE rn = 1
    ORDER BY date DESC
  `).all() as (Omit<StormLogRow, 'countryPath'> & { countryPath: string | null })[];
  return rows.map(r => ({ ...r, countryPath: parseCountryPath(r.countryPath) }));
}

/** Top 100 storms of all time by total accumulated strikes */
// Shared with pruneStormStrikes so "all-time record" protection matches
// exactly what the Top 100 page shows — the two must not drift apart.
export const TOP_STORMS_LIMIT = 100;
const STORM_QUALIFY_MIN_STRIKES = 5000;

export function getTop100Storms(): StormLogRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT storm_key AS stormKey, code, count, rate, lat, lon, city, date,
           origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
           start_time AS startTime, end_time AS endTime,
           traveled_km AS traveledKm, total_count AS totalCount,
           country_path AS countryPath
    FROM storms
    WHERE COALESCE(total_count, count) >= ?
    ORDER BY COALESCE(total_count, count) DESC
    LIMIT ?
  `).all(STORM_QUALIFY_MIN_STRIKES, TOP_STORMS_LIMIT) as (Omit<StormLogRow, 'countryPath'> & { countryPath: string | null })[];
  return rows.map(r => ({ ...r, countryPath: parseCountryPath(r.countryPath) }));
}

/** Keep bookmarks and in-flight replay requests valid after confirmed merges. */
export function resolveStormKey(stormKey: string): string {
  const db = getDb();
  const lookup = db.prepare('SELECT canonical_key FROM storm_aliases WHERE alias_key = ?');
  const seen = new Set<string>();
  let key = stormKey;
  while (!seen.has(key)) {
    seen.add(key);
    const row = lookup.get(key) as { canonical_key: string } | undefined;
    if (!row) return key;
    key = row.canonical_key;
  }
  return stormKey;
}

export function recordStormAlias(aliasKey: string, survivorKey: string): void {
  const db = getDb();
  const canonical = resolveStormKey(survivorKey);
  if (aliasKey === canonical) return;
  db.transaction(() => {
    // A split legitimately shares pre-split history. A confirmed merge unions
    // that history without losing either owner's missing replay points.
    db.prepare(`INSERT OR IGNORE INTO storm_replay_points (storm_key, strike_time, lat_milli, lon_milli)
      SELECT ?, strike_time, lat_milli, lon_milli FROM storm_replay_points WHERE storm_key = ?`).run(canonical, aliasKey);
    db.prepare('DELETE FROM storm_replay_points WHERE storm_key = ?').run(aliasKey);
    db.prepare('UPDATE storm_aliases SET canonical_key = ? WHERE canonical_key = ?').run(canonical, aliasKey);
    db.prepare('INSERT OR REPLACE INTO storm_aliases (alias_key, canonical_key) VALUES (?, ?)').run(aliasKey, canonical);
    // Preserve the absorbed system's event history and country/record links.
    // The obsolete storm-log row is removed by the confirmed tracker merge.
    db.prepare('UPDATE storm_events SET storm_key = ? WHERE storm_key = ?').run(canonical, aliasKey);
    db.prepare('UPDATE storm_records SET storm_key = ? WHERE storm_key = ?').run(canonical, aliasKey);
    db.prepare('UPDATE country_biggest_storms SET storm_key = ? WHERE storm_key = ?').run(canonical, aliasKey);
  })();
}

export function getStormByKey(stormKey: string): BiggestStorm | null {
  stormKey = resolveStormKey(stormKey);
  const db = getDb();
  const row = db.prepare(`
    SELECT storm_key AS stormKey, code, count, rate, lat, lon, city, date,
           origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
           start_time AS startTime, end_time AS endTime,
           traveled_km AS traveledKm, total_count AS totalCount, strikes,
           country_path AS countryPath
    FROM storms WHERE storm_key = ?
  `).get(stormKey) as (Omit<BiggestStorm, 'strikes' | 'countryPath'> & { strikes: string | null; countryPath: string | null }) | undefined;
  if (!row) return null;
  let strikes: StormStrike[] | null = null;
  try { strikes = row.strikes ? JSON.parse(row.strikes) : null; } catch { /* corrupt */ }
  let countryPath: string[] | null = null;
  try { countryPath = row.countryPath ? JSON.parse(row.countryPath) : null; } catch { /* ignore */ }
  return { ...row, strikes, countryPath };
}

/** Archive only replay membership accepted by the tracker, never raw proximity. */
export function saveStormReplayOwnership(
  assignments: Iterable<{ stormKey: string; strikes: StormStrike[] }>,
  nowMs = Date.now(),
): void {
  const db = getDb();
  const insert = db.prepare(`INSERT OR IGNORE INTO storm_replay_points
    (storm_key, strike_time, lat_milli, lon_milli) VALUES (?, ?, ?, ?)`);
  const keys = new Map<string, string>();
  db.transaction(() => {
    for (const assignment of assignments) {
      if (!assignment.stormKey) continue;
      let key = keys.get(assignment.stormKey);
      if (!key) { key = resolveStormKey(assignment.stormKey); keys.set(assignment.stormKey, key); }
      for (const point of assignment.strikes) {
        if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) continue;
        const [lat, lon, time] = point;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || time <= nowMs - GRID_RETENTION_MS || time > nowMs) continue;
        insert.run(key, time, Math.round(lat * 1000), Math.round(lon * 1000));
      }
    }
  })();
}

function ownedReplayPoints(stormKey: string, nowMs: number, after = -Infinity, until = nowMs): StormStrike[] {
  const rows = getDb().prepare(`SELECT lat_milli, lon_milli, strike_time FROM storm_replay_points
    WHERE storm_key = ? AND strike_time > ? AND strike_time <= ? ORDER BY strike_time, lat_milli, lon_milli`)
    .all(stormKey, Math.max(nowMs - GRID_RETENTION_MS, after), Math.min(nowMs, until)) as
    Array<{ lat_milli: number; lon_milli: number; strike_time: number }>;
  return rows.map(row => [row.lat_milli / 1000, row.lon_milli / 1000, row.strike_time]);
}

/** Caller holds the transaction so concurrent tracking cannot be overwritten. */
function persistOwnedReplay(storm: BiggestStorm, owned: StormStrike[]) {
  const recovered = recoverOwnedReplay(storm.strikes ?? [], owned);
  if (owned.length) {
    for (const table of ['storms', 'country_biggest_storms', 'storm_records']) {
      const copies = getDb().prepare(`SELECT rowid, strikes FROM ${table} WHERE storm_key = ?`)
        .all(storm.stormKey) as Array<{ rowid: number; strikes: string | null }>;
      const update = getDb().prepare(`UPDATE ${table} SET strikes = ? WHERE rowid = ?`);
      for (const copy of copies) {
        let original: StormStrike[];
        try { original = copy.strikes ? JSON.parse(copy.strikes) : []; } catch { continue; }
        if (!Array.isArray(original)) continue;
        // Each copy may preserve history absent from another sampled snapshot.
        // Retain it locally without promoting it to proof for the other copies.
        const repaired = recoverOwnedReplay(original, owned);
        if (repaired.recoveredCount) update.run(JSON.stringify(repaired.strikes), copy.rowid);
      }
    }
  }
  return recovered;
}

/** Restore only recorded replay ownership after both the storm and its tail settle. */
export function getStormReplayByKey(stormKey: string, nowMs = Date.now()): BiggestStorm | null {
  try {
    // Keep the snapshot, ownership read, and all three writes in one transaction.
    // Another process cannot revive the storm between the age check and update.
    return getDb().transaction(() => {
      const key = resolveStormKey(stormKey);
      const storm = getStormByKey(key);
      if (!storm || storm.endTime == null || !Array.isArray(storm.strikes) || !storm.strikes.length) return storm;
      const owned = ownedReplayPoints(key, nowMs);
      if (!owned.length) return storm;
      let latestActivity = storm.endTime;
      for (const point of [...storm.strikes, ...owned]) {
        if (Array.isArray(point) && Number.isFinite(point[2])) latestActivity = Math.max(latestActivity, point[2]);
      }
      if (nowMs - latestActivity <= 60 * 60_000) return storm;
      // Old replay_edges_v1 markers neither prove ownership nor identify which
      // saved points were inferred. Preserve old samples; never use them to
      // claim additional raw strikes or mark missing ownership as complete.
      const recovered = persistOwnedReplay(storm, owned);
      return recovered.recoveredCount > 0 ? { ...storm, strikes: recovered.strikes } : storm;
    }).immediate();
  } catch (err) {
    console.error(`[db] owned replay recovery failed for ${stormKey}:`, err);
    return getStormByKey(stormKey);
  }
}

/** 1-based rank of this storm by peak count across all logged storms */
export function getStormRank(totalCount: number): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM storms WHERE COALESCE(total_count, count) > ?').get(totalCount) as { n: number };
  return row.n + 1;
}

/** Global rank for each of the given storm keys (single query via window function) */
export function getStormRanks(stormKeys: string[]): Record<string, number> {
  if (stormKeys.length === 0) return {};
  const db = getDb();
  const placeholders = stormKeys.map(() => '?').join(',');
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT storm_key, ROW_NUMBER() OVER (ORDER BY COALESCE(total_count, count) DESC) AS rank FROM storms
    )
    SELECT storm_key AS stormKey, rank FROM ranked WHERE storm_key IN (${placeholders})
  `).all(...stormKeys) as Array<{ stormKey: string; rank: number }>;
  return Object.fromEntries(rows.map(r => [r.stormKey, r.rank]));
}

/** Total count of the nearest storm ranked just below `currentTotal` (the rank this storm just passed) */
export function getPrevRankThreshold(stormKey: string, currentTotal: number): number | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(total_count, count) AS threshold
    FROM storms
    WHERE storm_key != ? AND COALESCE(total_count, count) < ?
    ORDER BY COALESCE(total_count, count) DESC
    LIMIT 1
  `).get(stormKey, currentTotal) as { threshold: number } | undefined;
  return row?.threshold ?? null;
}

/** Total count of the nearest storm ranked above `currentTotal` for the rank-progress tag */
export function getNextRankThreshold(stormKey: string, currentTotal: number): number | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(total_count, count) AS threshold
    FROM storms
    WHERE storm_key != ? AND COALESCE(total_count, count) > ?
    ORDER BY COALESCE(total_count, count) ASC
    LIMIT 1
  `).get(stormKey, currentTotal) as { threshold: number } | undefined;
  return row?.threshold ?? null;
}

export interface RankedNeighbor {
  stormKey: string;
  rank: number;
  code: string;
  lat: number;
  lon: number;
  city: string | null;
  originCity: string | null;
  date: string;
  totalCount: number;
}

/** The `radius` storms ranked immediately above and below `stormKey` (plus itself) — for a race-leaderboard view centered on this storm's global position */
export function getNearbyRankedStorms(stormKey: string, radius = 10): RankedNeighbor[] {
  stormKey = resolveStormKey(stormKey);
  const db = getDb();
  return db.prepare(`
    WITH ranked AS (
      SELECT storm_key AS stormKey, code, lat, lon, city, origin_city AS originCity, date,
             COALESCE(total_count, count) AS totalCount,
             ROW_NUMBER() OVER (ORDER BY COALESCE(total_count, count) DESC, storm_key ASC) AS rank
      FROM storms
    ),
    me AS (SELECT rank FROM ranked WHERE stormKey = ?)
    SELECT ranked.* FROM ranked, me
    WHERE ranked.rank BETWEEN me.rank - ? AND me.rank + ?
    ORDER BY ranked.rank ASC
  `).all(stormKey, radius, radius) as RankedNeighbor[];
}

export interface StormLeaderboardPage {
  stormKey: string;
  currentRank: number;
  rows: RankedNeighbor[];
  hasMoreAbove: boolean;
  anchor?: RankedNeighbor;
}

/**
 * Read ten more competitors above a known storm, using its identity as the
 * cursor so live rank changes cannot shift a numeric page boundary. Without a
 * cursor, return the current storm's initial ten-above/ten-below neighborhood.
 */
export function getStormLeaderboardPage(stormKey: string, beforeKey?: string): StormLeaderboardPage | null {
  const db = getDb();
  return db.transaction(() => {
    const key = resolveStormKey(stormKey);
    const anchorKey = beforeKey === undefined ? key : resolveStormKey(beforeKey);
    const result = db.prepare(`
      WITH ranked AS (
        SELECT storm_key AS stormKey, code, lat, lon, city, origin_city AS originCity, date,
               COALESCE(total_count, count) AS totalCount,
               ROW_NUMBER() OVER (ORDER BY COALESCE(total_count, count) DESC, storm_key ASC) AS rank
        FROM storms
      ),
      me AS (SELECT rank FROM ranked WHERE stormKey = ?),
      anchor AS (SELECT rank FROM ranked WHERE stormKey = ?)
      SELECT ranked.*, me.rank AS currentRank FROM ranked, me, anchor
      WHERE ranked.rank BETWEEN anchor.rank - 10 AND anchor.rank + ?
      ORDER BY ranked.rank ASC
    `).all(key, anchorKey, beforeKey === undefined ? 10 : 0) as Array<RankedNeighbor & { currentRank: number }>;
    // Including the anchor distinguishes the top of the list from a deleted
    // cursor. Both keys and every rank are read in this same SQLite snapshot.
    if (result.length === 0) return null;
    const currentRank = result[0].currentRank;
    const rows = result.map(({ stormKey, rank, code, lat, lon, city, originCity, date, totalCount }) => ({
      stormKey, rank, code, lat, lon, city, originCity, date, totalCount,
    }));
    // A known row's ordinal can change when higher storms merge or disappear.
    // Refresh the cursor too, including when there are no rows left above it.
    const anchor = beforeKey === undefined ? undefined : rows.pop();
    return {
      stormKey: key, currentRank, rows, hasMoreAbove: rows.length > 0 && rows[0].rank > 1,
      ...(anchor ? { anchor } : {}),
    };
  })();
}

export function deleteStorm(stormKey: string): void {
  const db = getDb();
  db.prepare('DELETE FROM storms WHERE storm_key = ?').run(stormKey);
  db.prepare('DELETE FROM storm_records WHERE storm_key = ?').run(stormKey);
  db.prepare('DELETE FROM country_biggest_storms WHERE storm_key = ?').run(stormKey);
  db.prepare('DELETE FROM storm_replay_points WHERE storm_key = ?').run(stormKey);
}

/**
 * Scan today's storms and merge any pair whose centroids are within mergeKm.
 * The storm with the lower peak count is absorbed: its DB rows are deleted,
 * and the survivor inherits whichever values are better (earlier start, higher peak).
 * Called at startup and can be called periodically.
 */
export function consolidateNearbyStorms(mergeKm = 75): void {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const hourAgo = Date.now() - 60 * 60 * 1000;

  const rows = db.prepare(`
    SELECT storm_key AS stormKey, count, rate, lat, lon, city, date,
           origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
           start_time AS startTime, end_time AS endTime,
           traveled_km AS traveledKm, total_count AS totalCount,
           country_path AS countryPath
    FROM storms
    WHERE date = ? AND end_time > ?
    ORDER BY count DESC
  `).all(today, hourAgo) as Array<{
    stormKey: string; count: number; rate: number;
    lat: number; lon: number; city: string | null; date: string;
    originLat: number | null; originLon: number | null; originCity: string | null;
    startTime: number | null; endTime: number | null;
    traveledKm: number | null; totalCount: number | null;
    countryPath: string | null;
  }>;

  if (rows.length < 2) return;

  const cos = Math.cos(rows[0].lat * Math.PI / 180);
  function km(a: typeof rows[0], b: typeof rows[0]): number {
    const dLat = (a.lat - b.lat) * 111.32;
    const dLon = (a.lon - b.lon) * 111.32 * cos;
    return Math.hypot(dLat, dLon);
  }

  const update = db.prepare(`
    UPDATE storms SET
      count = ?, rate = ?, start_time = ?,
      origin_lat = ?, origin_lon = ?, origin_city = ?,
      traveled_km = ?, total_count = ?
    WHERE storm_key = ?
  `);

  let anyMerged = true;
  while (anyMerged) {
    anyMerged = false;
    outer: for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        if (km(rows[i], rows[j]) >= mergeKm) continue;
        const big = rows[i]; // rows sorted DESC by count so i is always bigger
        const small = rows[j];
        // Inherit earlier start and better travel distance
        const newStart = (small.startTime != null && (big.startTime == null || small.startTime < big.startTime))
          ? small.startTime : big.startTime;
        const newOriginLat = newStart === small.startTime ? small.originLat : big.originLat;
        const newOriginLon = newStart === small.startTime ? small.originLon : big.originLon;
        const newOriginCity = newStart === small.startTime ? small.originCity : big.originCity;
        const newTravel = Math.max(big.traveledKm ?? 0, small.traveledKm ?? 0);
        const newTotal = (big.totalCount ?? 0) + (small.totalCount ?? 0);
        update.run(big.count, big.rate, newStart, newOriginLat, newOriginLon, newOriginCity, newTravel, newTotal, big.stormKey);
        // Update in-memory row so subsequent passes use updated values
        big.startTime = newStart; big.originLat = newOriginLat; big.originLon = newOriginLon;
        big.originCity = newOriginCity; big.traveledKm = newTravel; big.totalCount = newTotal;
        // Preserve strikes: if the absorbed storm has a longer blob, copy it to
        // the survivor so the replay doesn't lose geographic/temporal coverage.
        const strikeLens = db.prepare(`
          SELECT
            json_array_length(COALESCE((SELECT strikes FROM storms WHERE storm_key = ?), '[]')) AS bigLen,
            json_array_length(COALESCE((SELECT strikes FROM storms WHERE storm_key = ?), '[]')) AS smallLen
        `).get(big.stormKey, small.stormKey) as { bigLen: number; smallLen: number } | undefined;
        if (strikeLens && strikeLens.smallLen > strikeLens.bigLen) {
          db.prepare(`
            UPDATE storms SET strikes = (SELECT strikes FROM storms WHERE storm_key = ?)
            WHERE storm_key = ?
          `).run(small.stormKey, big.stormKey);
        }
        // Delete the absorbed storm from all tables
        db.prepare('DELETE FROM storms WHERE storm_key = ?').run(small.stormKey);
        db.prepare('DELETE FROM storm_records WHERE storm_key = ?').run(small.stormKey);
        db.prepare('DELETE FROM country_biggest_storms WHERE storm_key = ?').run(small.stormKey);
        rows.splice(j, 1);
        anyMerged = true;
        break outer;
      }
    }
  }
}

export function rebuildStormRecords(): void {
  const db = getDb();
  const rows = db.prepare(`
    SELECT storm_key AS stormKey, code, count, rate, lat, lon, city, date,
           origin_lat AS originLat, origin_lon AS originLon, origin_city AS originCity,
           start_time AS startTime, end_time AS endTime,
           traveled_km AS traveledKm, total_count AS totalCount,
           strikes, country_path AS countryPath
    FROM storms
    WHERE storm_key IS NOT NULL
  `).all() as Array<Omit<BiggestStorm, 'strikes' | 'countryPath'> & { stormKey: string; strikes: string | null; countryPath: string | null }>;

  const candidates: BiggestStorm[] = rows.map(r => ({
    ...r,
    strikes: (() => { try { return r.strikes ? JSON.parse(r.strikes) : null; } catch { return null; } })(),
    countryPath: (() => { try { return r.countryPath ? JSON.parse(r.countryPath) : null; } catch { return null; } })(),
  }));

  db.prepare('DELETE FROM storm_records').run();
  upsertStormRecords(candidates);
}

interface StrikeDedupeResult {
  strikes: StormStrike[];
  originalLength: number;
  uniqueLength: number;
}

/**
 * Removes exact-duplicate [lat,lon,time] points from a stored strikes blob.
 * Returns null if the blob is missing, unparseable, empty, or already has no
 * duplicates (nothing to correct).
 */
function dedupeStrikeBlob(raw: string | null): StrikeDedupeResult | null {
  if (!raw) return null;
  let points: StormStrike[];
  try { points = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(points) || points.length === 0) return null;
  const seen = new Set<string>();
  const unique: StormStrike[] = [];
  for (const p of points) {
    const key = `${p[0]},${p[1]},${p[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  if (unique.length === points.length) return null;
  return { strikes: unique, originalLength: points.length, uniqueLength: unique.length };
}

/**
 * Best-effort retroactive correction for storms recorded before the WS
 * duplicate-delivery fix (server.mjs) and the merge-blob dedup fix
 * (api/strikes/route.ts absorbInto): every physical strike could be counted
 * 2-4x at ingestion, and flapping split/merge cycles re-added the same points
 * to a storm's strikes blob on every cycle, so pre-fix rows have inflated
 * total_count/count/rate and literal duplicate points in their strikes blob.
 *
 * There's no way to recover the exact true total after the fact — the stored
 * strikes blob is a thinned sample, not the full history. Instead this uses
 * the duplication ratio measured directly in each storm's own sample
 * (unique / original count) as a stand-in for the ratio over its whole life,
 * and scales total_count/count/rate down by that ratio. The bug was constant
 * (every delivery duplicated, not bursty), so a sample-measured ratio is a
 * reasonable approximation. Only ever scales DOWN, and never below the
 * number of strikes actually known to be unique in the sample. Storms whose
 * stored sample has no detectable duplicates are left untouched.
 */
export function recalculateDuplicateStormTotals(): { storms: number; countryBiggest: number } {
  const db = getDb();

  function correctTable(table: 'storms' | 'country_biggest_storms', idColumn: 'storm_key' | 'code'): number {
    let fixed = 0;
    const rows = db.prepare(
      `SELECT ${idColumn} AS id, strikes, total_count AS totalCount, count, rate FROM ${table} WHERE strikes IS NOT NULL`
    ).all() as Array<{ id: string; strikes: string; totalCount: number | null; count: number; rate: number }>;
    const update = db.prepare(`UPDATE ${table} SET strikes = ?, total_count = ?, count = ?, rate = ? WHERE ${idColumn} = ?`);
    db.transaction(() => {
      for (const row of rows) {
        const dedup = dedupeStrikeBlob(row.strikes);
        if (!dedup) continue;
        const ratio = dedup.uniqueLength / dedup.originalLength;
        const correctedTotal = Math.max(dedup.uniqueLength, Math.round((row.totalCount ?? row.count) * ratio));
        const correctedCount = Math.max(1, Math.round(row.count * ratio));
        const correctedRate = row.rate * ratio;
        update.run(JSON.stringify(dedup.strikes), correctedTotal, correctedCount, correctedRate, row.id);
        fixed++;
      }
    })();
    return fixed;
  }

  const storms = correctTable('storms', 'storm_key');
  const countryBiggest = correctTable('country_biggest_storms', 'code');

  // storm_records is fully re-derived from the (now corrected) storms table,
  // so hall-of-fame rankings reflect corrected totals without separate repair logic.
  rebuildStormRecords();

  return { storms, countryBiggest };
}

/** Returns lat/lon for all recent (within 1 hour) DB storm entries, keyed by storm_key. */
export function getRecentStormPositions(): Map<string, { lat: number; lon: number }> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const rows = db.prepare(
    `SELECT storm_key, lat, lon FROM storms WHERE date = ? AND end_time > ? AND storm_key IS NOT NULL`
  ).all(today, hourAgo) as Array<{ storm_key: string; lat: number; lon: number }>;
  const map = new Map<string, { lat: number; lon: number }>();
  for (const r of rows) map.set(r.storm_key, { lat: r.lat, lon: r.lon });
  return map;
}

export function saveTrackedStorms(storms: unknown[]): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO counters (key, value) VALUES (?, ?)')
    .run('trackedStorms', JSON.stringify(storms));
}

export function loadTrackedStorms(): unknown[] {
  const db = getDb();
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get('trackedStorms') as { value: string } | undefined;
  if (!row) return [];
  try { return JSON.parse(row.value) as unknown[]; } catch { return []; }
}

export function pruneStormStrikes(now: number = Date.now()): void {
  const db = getDb();
  const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;

  // Preserve strikes forever for:
  //  - each date's daily record (biggest storm of that day by total_count —
  //    matches getBiggestStormPerDay's own ranking, not the old count-only check)
  //  - the all-time Top 100 by total_count (matches getTop100Storms exactly —
  //    TOP_STORMS_LIMIT/STORM_QUALIFY_MIN_STRIKES are shared with it so the two
  //    can't drift apart)
  //  - any current global record holder (biggest/longest/farthest/most), which
  //    can hold a category (e.g. "longest") without being a Top 100 total-count storm
  // Everything else still drops its strikes blob after 7 days.
  db.prepare(`
    WITH qualifying AS (
      SELECT storm_key, date, COALESCE(total_count, count) AS metric
      FROM storms
      WHERE COALESCE(total_count, count) >= ?
    ),
    ranked AS (
      SELECT storm_key,
             ROW_NUMBER() OVER (PARTITION BY date ORDER BY metric DESC) AS daily_rank,
             ROW_NUMBER() OVER (ORDER BY metric DESC) AS alltime_rank
      FROM qualifying
    )
    UPDATE storms SET strikes = NULL
    WHERE strikes IS NOT NULL
      AND end_time < ?
      AND storm_key NOT IN (SELECT storm_key FROM ranked WHERE daily_rank = 1)
      AND storm_key NOT IN (SELECT storm_key FROM ranked WHERE alltime_rank <= ?)
      AND storm_key NOT IN (SELECT storm_key FROM storm_records WHERE storm_key IS NOT NULL)
  `).run(STORM_QUALIFY_MIN_STRIKES, cutoff7d, TOP_STORMS_LIMIT);

  // Storm rows are kept forever so global rankings stay stable.
  // Only the strikes blob is expensive — that's already nulled above after 7 days.
}

/**
 * Retroactively fill in missing countries for recent storms by sampling stored
 * strike coordinates. Pass getCountryCode from geoCountry to avoid a circular
 * import between db ↔ geoCountry.
 */
export function hasMissingCountryPaths(): boolean {
  const db = getDb();
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM storms WHERE strikes IS NOT NULL AND country_path IS NULL').get() as { n: number };
  return n > 0;
}

export function enrichStormCountryPaths(
  lookupCC: (lat: number, lon: number) => string | null,
  limitDays = 30,
): void {
  const db = getDb();
  const cutoff = Date.now() - limitDays * 24 * 60 * 60 * 1000;
  const rows = db.prepare(`
    SELECT storm_key, country_path, strikes
    FROM storms
    WHERE strikes IS NOT NULL AND end_time > ?
    ORDER BY end_time DESC
    LIMIT 300
  `).all(cutoff) as Array<{ storm_key: string; country_path: string | null; strikes: string }>;

  const update = db.prepare('UPDATE storms SET country_path = ? WHERE storm_key = ?');

  for (const row of rows) {
    try {
      const strikes = JSON.parse(row.strikes) as StormStrike[];
      // Keep existing path order; only append genuinely new countries
      const existing: string[] = row.country_path ? JSON.parse(row.country_path) : [];
      const seen = new Set(existing);
      let changed = false;
      // Sample every 8th strike for efficiency (~12% of points)
      for (let i = 0; i < strikes.length; i += 8) {
        const cc = lookupCC(strikes[i][0], strikes[i][1]);
        if (cc && !seen.has(cc)) { existing.push(cc); seen.add(cc); changed = true; }
      }
      if (changed) update.run(JSON.stringify(existing), row.storm_key);
    } catch { /* skip corrupt rows */ }
  }
}

/**
 * The inverse cleanup of enrichStormCountryPaths: a storm's `strikes` blob is
 * capped and thinned (see accumulateStrikes/absorbInto in api/strikes/route.ts),
 * so for a long-lived storm the surviving sample can lose every point from a
 * country it legitimately passed through — country_path (append-only, never
 * thinned) then lists a country the replay has no evidence for at all, which
 * reads as a bug even though the country really was hit. This can't restore
 * the missing strikes, but it keeps what's DISPLAYED consistent with what the
 * replay can actually show: countries with no supporting strikes left in the
 * (thinned) sample are dropped, always keeping the storm's own tracked `code`
 * so the single-country display still has something to fall back to. Safe to
 * run on every startup — a no-op once a storm's path has already been reconciled.
 */
export function reconcileCountryPaths(lookupCC: (lat: number, lon: number) => string | null): number {
  const db = getDb();
  const rows = db.prepare(`
    SELECT storm_key, code, country_path, strikes FROM storms
    WHERE strikes IS NOT NULL AND country_path IS NOT NULL
  `).all() as Array<{ storm_key: string; code: string; country_path: string; strikes: string }>;

  const update = db.prepare('UPDATE storms SET country_path = ? WHERE storm_key = ?');
  let fixed = 0;

  for (const row of rows) {
    let path: string[];
    let strikes: StormStrike[];
    try {
      path = JSON.parse(row.country_path);
      strikes = JSON.parse(row.strikes);
    } catch { continue; }
    if (!Array.isArray(path) || path.length <= 1) continue;

    const evidenced = new Set<string>();
    // Unlike enrichStormCountryPaths' fixed every-8th stride (fine for ADDING —
    // missing a rare country there just delays it being added later), missing
    // one here means wrongly REMOVING a country that was genuinely hit. Scale
    // the stride down for small arrays so short/well-preserved storms get
    // full coverage, capping the sample count for very large ones.
    const step = Math.max(1, Math.floor(strikes.length / 200));
    for (let i = 0; i < strikes.length; i += step) {
      const cc = lookupCC(strikes[i][0], strikes[i][1]);
      if (cc) evidenced.add(cc);
    }
    evidenced.add(row.code); // always keep the storm's own designated country

    const next = path.filter(cc => evidenced.has(cc));
    if (next.length === 0) next.push(row.code);

    const unchanged = next.length === path.length && next.every((cc, i) => cc === path[i]);
    if (!unchanged) {
      update.run(JSON.stringify(next), row.storm_key);
      fixed++;
    }
  }
  return fixed;
}

// ── Backfill a storm's thinned/truncated replay tail from recorded ownership ──
// accumulateStrikes (api/strikes/route.ts) sub-samples the replay blob once a
// storm exceeds ALL_STRIKES_MAX; before the tail-guarantee fix landed, a quiet
// pass late in a long storm's life could be skipped entirely, leaving the
// stored blob's last point far short of the storm's real end_time. The
// numeric total_count is NOT affected (it's an unconditional counter,
// unrelated to the blob) — only the map/replay's geographic sample is thin.
// Startup tail repair uses the same durable membership as replay reads. It
// must never retrack raw geographic neighbors and persist a guessed identity.
const BACKFILL_CHUNK_MS = 5 * 60_000;
const BACKFILL_MIN_GAP_MS = 15 * 60_000;

export interface BackfillResult {
  stormKey: string;
  recoveredStrikes: number;
  chunksMatched: number;
  chunksMissed: number;
  reconstructedUntilMs: number | null;
  reachedEnd: boolean;
}

/** Restore missing tail points only when their replay membership was recorded. */
export function backfillStormTail(stormKey: string, nowMs = Date.now()): BackfillResult | null {
  return getDb().transaction(() => {
    const key = resolveStormKey(stormKey);
    const storm = getStormByKey(key);
    if (!storm || storm.endTime == null || !Array.isArray(storm.strikes) || !storm.strikes.length) return null;
    let last = -Infinity;
    for (const point of storm.strikes) {
      if (Array.isArray(point) && Number.isFinite(point[2])) last = Math.max(last, point[2]);
    }
    if (!Number.isFinite(last) || storm.endTime - last < BACKFILL_MIN_GAP_MS || nowMs - last > GRID_RETENTION_MS) return null;
    const owned = ownedReplayPoints(key, nowMs, last, storm.endTime);
    const recovered = persistOwnedReplay(storm, owned);
    const chunks = new Set(owned.map(point => Math.floor((point[2] - last - 1) / BACKFILL_CHUNK_MS)));
    const latest = owned.length ? owned[owned.length - 1][2] : null;
    return {
      stormKey: key, recoveredStrikes: recovered.recoveredCount,
      chunksMatched: chunks.size,
      chunksMissed: Math.max(0, Math.ceil((storm.endTime - last) / BACKFILL_CHUNK_MS) - chunks.size),
      reconstructedUntilMs: latest,
      reachedEnd: latest != null && latest >= storm.endTime - BACKFILL_CHUNK_MS,
    };
  }).immediate();
}

/** Retry gaps when durable ownership is available; missing evidence stays missing. */
export function backfillGappedStormTails(nowMs = Date.now()): BackfillResult[] {
  const rows = getDb().prepare(`SELECT storm_key FROM storms
    WHERE strikes IS NOT NULL AND end_time IS NOT NULL AND end_time > ?`)
    .all(nowMs - GRID_RETENTION_MS) as Array<{ storm_key: string }>;
  const results: BackfillResult[] = [];
  for (const { storm_key } of rows) {
    try {
      const result = backfillStormTail(storm_key, nowMs);
      if (result) results.push(result);
    } catch { /* skip this storm, keep going */ }
  }
  return results;
}

export function getCountryHistory(code: string): Array<{ date: string; count: number }> {
  const db = getDb();
  return db.prepare('SELECT date, count FROM daily_strikes WHERE code = ? ORDER BY date DESC').all(code) as Array<{ date: string; count: number }>;
}

export function getGlobalDailyTotals(): Array<{ date: string; total: number }> {
  const db = getDb();
  return db.prepare('SELECT date, SUM(count) AS total FROM daily_strikes GROUP BY date ORDER BY date DESC').all() as Array<{ date: string; total: number }>;
}

let _upsertTotal: Database.Statement | null = null;
let _upsertCountry: Database.Statement | null = null;

export function saveCounters(total: number, countries: Record<string, number>): void {
  const db = getDb();
  const upsertTotal = (_upsertTotal ??= db.prepare('INSERT OR REPLACE INTO counters (key, value) VALUES (?, ?)'));
  const upsertCountry = (_upsertCountry ??= db.prepare('INSERT INTO countries (code, count) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET count = excluded.count'));

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

// ── Storm events (merge / split log) ──────────────────────────────────────
export function recordStormEvent(
  stormKey: string,
  eventType: 'merge' | 'split',
  ts: number,
  relatedKey: string | null = null,
  relatedCity: string | null = null,
  relatedCc: string | null = null,
  strikesAbsorbed: number | null = null,
  fragmentLabel: string | null = null,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO storm_events (storm_key, event_type, ts, related_key, related_city, related_cc, strikes_absorbed, fragment_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(stormKey, eventType, ts, relatedKey, relatedCity, relatedCc, strikesAbsorbed, fragmentLabel);
}

export function countSplitEvents(stormKey: string): number {
  const db = getDb();
  return (db.prepare(`SELECT COUNT(*) AS n FROM storm_events WHERE storm_key = ? AND event_type = 'split'`).get(stormKey) as { n: number }).n;
}

/** Prune storm_events rows older than 30 days (called from hourly maintenance) */
export function pruneStormEvents(): void {
  const db = getDb();
  db.prepare('DELETE FROM storm_events WHERE ts < ?').run(Date.now() - 30 * 24 * 60 * 60 * 1000);
}


export interface IntakeStrike {
  id: number;
  identity: string;
  receivedAt: number;
  time: number;
  lat: number;
  lon: number;
  cc: string | null;
  countDate: string;
  live: number;
}
export interface IntakeCheckpoint { through: number; time: number; stormSeq: number }
const INTAKE_COLUMNS = 'id, identity, received_at AS receivedAt, strike_time AS time, lat, lon, cc, count_date AS countDate, live';
export const MAX_PENDING_INTAKE = 100_000;

export function loadIntakeCheckpoint(): IntakeCheckpoint | null {
  const row = getDb().prepare("SELECT value FROM counters WHERE key = 'intake_checkpoint'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) as IntakeCheckpoint : null;
}

/** Commit before acknowledging/broadcasting a delivery. No volatile-only intake. */
export function appendStrikeIntake(strikes: Array<Omit<IntakeStrike, 'id'>>): IntakeStrike[] {
  if (!strikes.length) return [];
  const db = getDb();
  const seen = db.prepare('SELECT 1 FROM strike_intake WHERE identity = ?');
  const insert = db.prepare(`INSERT INTO strike_intake
    (identity, received_at, strike_time, lat, lon, cc, count_date, live) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  return db.transaction(() => {
    const through = loadIntakeCheckpoint()?.through ?? 0;
    let pending = (db.prepare('SELECT COUNT(*) AS n FROM strike_intake WHERE id > ?').get(through) as { n: number }).n;
    const accepted: IntakeStrike[] = [];
    for (const point of strikes) {
      if (seen.get(point.identity)) continue;
      // Failed checkpoints cannot grow the journal forever. Reject new intake
      // before accepting it; the server becomes unhealthy and stops its feeds.
      if (pending >= MAX_PENDING_INTAKE) throw new Error('Durable intake is full; checkpoint required');
      const result = insert.run(point.identity, point.receivedAt, point.time, point.lat, point.lon, point.cc, point.countDate, point.live);
      accepted.push({ ...point, id: Number(result.lastInsertRowid) });
      pending++;
    }
    return accepted;
  })();
}

export function loadStrikeIntake(): IntakeStrike[] {
  return getDb().prepare(`SELECT ${INTAKE_COLUMNS} FROM strike_intake ORDER BY id`).all() as IntakeStrike[];
}

/** Archive projection and its acknowledgement share one commit, including cells. */
export function flushIntakeArchive(through = Number.MAX_SAFE_INTEGER): void {
  const db = getDb();
  db.transaction(() => {
    const rows = db.prepare(`SELECT ${INTAKE_COLUMNS} FROM strike_intake WHERE archived = 0 AND id <= ? ORDER BY id`)
      .all(through) as IntakeStrike[];
    const live = rows.filter(p => p.live);
    archiveGridStrikeBatch(live);
    // Grid-cell totals are lifetime counters. Recover them even after a long
    // outage, then expire only their raw points under the existing retention.
    const cutoff = Date.now() - GRID_RETENTION_MS;
    if (live.some(p => p.time < cutoff)) db.prepare('DELETE FROM grid_strikes WHERE strike_time < ?').run(cutoff);
    db.prepare('UPDATE strike_intake SET archived = 1 WHERE archived = 0 AND id <= ?').run(through);
  })();
}

/** A snapshot includes every projection, event and alias, or none of them. */
export function checkpointStrikeIntake(checkpoint: IntakeCheckpoint, persist: () => void): void {
  const db = getDb();
  db.transaction(() => {
    persist();
    flushIntakeArchive(checkpoint.through);
    db.prepare('INSERT OR REPLACE INTO counters (key, value) VALUES (?, ?)')
      .run('intake_checkpoint', JSON.stringify(checkpoint));
    // Retain the observation window and at least the previous feed's 50k
    // physical identities across restarts, capped at 200k processed entries.
    // Never prune uncheckpointed intake (separately bounded at 100k).
    db.prepare('DELETE FROM strike_intake WHERE id <= ? AND ((received_at < ? AND id < ?) OR id < ?)')
      .run(checkpoint.through, checkpoint.time - 10 * 60_000, checkpoint.through - 50_000, checkpoint.through - 200_000);
  })();
}
