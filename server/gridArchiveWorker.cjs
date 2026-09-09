'use strict';

const { parentPort, workerData, isMainThread } = require('node:worker_threads');
const Database = require('better-sqlite3');

// Every public raw-grid read runs here, on a separate read-only connection.
// WAL readers neither run on the ingestion thread nor hold the writer lock.
function queryGridArchive(db, query) {
  return db.transaction(() => {
    const snapshotId = query.snapshotId ?? db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM grid_strikes').get().id;
    const cell = query.kind === 'cell';
    const bounds = query.bounds;
    const filter = cell ? 'cell_id = ?' : `lat BETWEEN ? AND ? AND ${bounds.minLon <= bounds.maxLon ? 'lon BETWEEN ? AND ?' : '(lon >= ? OR lon <= ?)'}`;
    const geography = cell ? [query.cellId] : [bounds.minLat, bounds.maxLat, bounds.minLon, bounds.maxLon];
    const index = cell ? 'idx_gs_cell_time' : 'idx_gs_time';
    // The existing cell index is (cell_id, strike_time DESC, implicit rowid ASC).
    // Match its tie order to avoid a large equal-time burst needing a temp sort.
    const idOrder = cell ? 'ASC' : 'DESC';
    const total = query.kind === 'viewport' ? undefined : query.total ?? db.prepare(`
      SELECT COUNT(*) AS n FROM grid_strikes INDEXED BY ${index}
      WHERE ${filter} AND strike_time BETWEEN ? AND ? AND id <= ?
    `).get(...geography, query.since, query.until, snapshotId).n;
    const strikes = [];
    if (query.after) {
      strikes.push(...db.prepare(`
        SELECT id, lat, lon, strike_time FROM grid_strikes INDEXED BY ${index}
        WHERE ${filter} AND strike_time = ? AND id <= ? ${cell ? 'AND id > ?' : ''}
        ORDER BY id ${idOrder} LIMIT ?
      `).all(...geography, query.after.strikeTime,
        cell ? snapshotId : Math.min(snapshotId, query.after.id - 1),
        ...(cell ? [query.after.id] : []), query.limit + 1));
    }
    if (strikes.length <= query.limit) {
      strikes.push(...db.prepare(`
        SELECT id, lat, lon, strike_time FROM grid_strikes INDEXED BY ${index}
        WHERE ${filter} AND strike_time >= ? AND strike_time ${query.after ? '<' : '<='} ? AND id <= ?
        ORDER BY strike_time DESC, id ${idOrder} LIMIT ?
      `).all(...geography, query.since, query.after?.strikeTime ?? query.until, snapshotId, query.limit + 1 - strikes.length));
    }
    const more = strikes.length > query.limit;
    if (more) strikes.pop();
    const last = strikes[strikes.length - 1];
    const metadata = cell ? db.prepare('SELECT cell_id, total_strikes, last_strike_time FROM grid_cells WHERE cell_id = ?').get(query.cellId) ?? null : undefined;
    return { strikes, snapshotId, total, cell: metadata, next: more ? { strikeTime: last.strike_time, id: last.id } : null };
  })();
}

module.exports = { queryGridArchive };

if (!isMainThread) {
  const db = new Database(workerData.dbFile, { readonly: true, fileMustExist: true, timeout: 100 });
  db.pragma('query_only = ON');
  db.pragma('cache_size = -4000');
  parentPort.on('message', ({ id, query }) => {
    try {
      parentPort.postMessage({ id, result: queryGridArchive(db, query) });
    } catch {
      parentPort.postMessage({ id, error: 'Archive temporarily unavailable' });
    }
  });
}
