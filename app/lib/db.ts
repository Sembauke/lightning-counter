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
  _db.exec(`
    CREATE TABLE IF NOT EXISTS counters (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS countries (
      code  TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );
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
