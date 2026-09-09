// Pure geometry utilities for storm buffer outlines. No DOM/canvas dependency
// so these can be unit-tested in Node.

export interface Point { x: number; y: number }

export interface GeographicPoint { lat: number; lon: number }

export interface GeographicOutline {
  /** Normalized Web Mercator coordinates; project these only when drawing. */
  segments: Array<[number, number, number, number]>;
  core: { nx: number; ny: number };
  /** Dense disconnected parts of the same storm, ordered by strike count. */
  cores: Array<{ nx: number; ny: number; count: number }>;
  extentKm: number;
  resolutionKm: number;
}

function componentCores(points: Point[], grid: BufferGrid, cellKm: number): Array<Point & { count: number }> {
  const { data, cols, rows, originX, originY, res } = grid;
  const labels = new Uint32Array(data.length);
  const queue = new Uint32Array(data.length);
  let label = 0;
  // Four-neighbour connectivity agrees with the separate diagonal regions in
  // marching squares cases 5 and 10; corner contact alone is not a bridge.
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || labels[start]) continue;
    label++;
    labels[start] = label;
    queue[0] = start;
    let head = 0, tail = 1;
    while (head < tail) {
      const index = queue[head++];
      const col = index % cols;
      const neighbors = [
        col > 0 ? index - 1 : -1,
        col + 1 < cols ? index + 1 : -1,
        index >= cols ? index - cols : -1,
        index + cols < data.length ? index + cols : -1,
      ];
      for (const next of neighbors) {
        if (next < 0 || !data[next] || labels[next]) continue;
        labels[next] = label;
        queue[tail++] = next;
      }
    }
  }

  const components = new Map<number, Point[]>();
  for (const point of points) {
    const col = Math.max(0, Math.min(cols - 1, Math.round((point.x - originX) / res)));
    const row = Math.max(0, Math.min(rows - 1, Math.round((point.y - originY) / res)));
    const key = labels[row * cols + col];
    if (!key) continue;
    const component = components.get(key);
    if (component) component.push(point);
    else components.set(key, [point]);
  }
  return [...components.values()]
    .filter(component => component.length >= 10)
    .sort((a, b) => b.length - a.length)
    .map(component => ({ ...densityCore(component, cellKm), count: component.length }));
}

const EARTH_CIRCUMFERENCE_KM = 40_075.016686;
const MAX_MERCATOR_LAT = 85.05112878;

function mercatorY(lat: number): number {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const sin = Math.sin(clamped * Math.PI / 180);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
}

/**
 * Builds the storm footprint before any screen projection. Both the circle
 * radius and raster resolution use ground kilometres at the storm's reference
 * latitude, so zooming and panning cannot connect or split its contours.
 *
 * Longitudes are unwrapped around the reference: a storm crossing the date line
 * remains a small local outline. Its normalized x coordinates may exceed [0, 1].
 */
export function buildGeographicOutline(
  points: GeographicPoint[],
  reference: GeographicPoint,
  bufferKm = 10,
  resolutionKm = 1,
): GeographicOutline | null {
  if (!Number.isFinite(reference.lat) || Math.abs(reference.lat) > 90
    || !Number.isFinite(reference.lon) || Math.abs(reference.lon) > 180
    || !Number.isFinite(bufferKm) || bufferKm <= 0
    || !Number.isFinite(resolutionKm) || resolutionKm <= 0) return null;

  const refLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, reference.lat));
  const worldKm = EARTH_CIRCUMFERENCE_KM * Math.cos(refLat * Math.PI / 180);
  const referenceX = (reference.lon + 180) / 360;
  const referenceY = mercatorY(reference.lat);
  const projected: Point[] = [];
  let extentKm = 0;
  for (const point of points) {
    if (!Number.isFinite(point.lat) || Math.abs(point.lat) > 90
      || !Number.isFinite(point.lon) || Math.abs(point.lon) > 180) continue;
    const deltaLon = ((point.lon - reference.lon + 540) % 360) - 180;
    const nx = referenceX + deltaLon / 360;
    const ny = mercatorY(point.lat);
    projected.push({ x: nx * worldKm, y: ny * worldKm });
    extentKm = Math.max(extentKm, Math.hypot(nx - referenceX, ny - referenceY) * worldKm);
  }
  if (projected.length === 0) return null;

  // The allocation guard depends on the geographic data, never the viewport.
  // Exceptionally broad groups use a coarser geographic grid at every zoom.
  let grid = rasteriseBuffer(projected, bufferKm, resolutionKm);
  while (!grid) {
    resolutionKm *= 2;
    grid = rasteriseBuffer(projected, bufferKm, resolutionKm);
  }
  const cores = componentCores(projected, grid, bufferKm);
  const core = cores[0] ?? densityCore(projected, bufferKm);
  return {
    segments: marchingSquares(grid).map(([ax, ay, bx, by]) => [
      ax / worldKm, ay / worldKm, bx / worldKm, by / worldKm,
    ]),
    core: { nx: core.x / worldKm, ny: core.y / worldKm },
    cores: cores.map(part => ({ nx: part.x / worldKm, ny: part.y / worldKm, count: part.count })),
    extentKm: extentKm + bufferKm,
    resolutionKm,
  };
}

/**
 * Returns the centroid of the grid cell with the highest point density.
 * cellPx is the grid cell size in the same units as the points.
 */
export function densityCore(pts: Point[], cellPx: number): Point {
  if (pts.length === 0) return { x: 0, y: 0 };
  const grid = new Map<string, { sx: number; sy: number; n: number }>();
  for (const p of pts) {
    const k = `${Math.floor(p.x / cellPx)}:${Math.floor(p.y / cellPx)}`;
    const c = grid.get(k);
    if (c) { c.sx += p.x; c.sy += p.y; c.n++; }
    else grid.set(k, { sx: p.x, sy: p.y, n: 1 });
  }
  let best = { sx: 0, sy: 0, n: -1 };
  for (const c of grid.values()) { if (c.n > best.n) best = c; }
  return best.n <= 0 ? { ...pts[0] } : { x: best.sx / best.n, y: best.sy / best.n };
}

export interface BufferGrid {
  data: Uint8Array;
  cols: number;
  rows: number;
  originX: number;
  originY: number;
  res: number;
}

const MAX_CELLS = 250_000;

/**
 * Rasterises each point as a filled circle of radius bufferPx onto a grid
 * with `res` pixels per cell. Returns null if the bounding box would exceed
 * MAX_CELLS (safety guard against runaway allocations).
 */
export function rasteriseBuffer(pts: Point[], bufferPx: number, res = 4): BufferGrid | null {
  if (pts.length === 0) return null;
  let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
  for (const p of pts) {
    if (p.x - bufferPx < mnX) mnX = p.x - bufferPx;
    if (p.y - bufferPx < mnY) mnY = p.y - bufferPx;
    if (p.x + bufferPx > mxX) mxX = p.x + bufferPx;
    if (p.y + bufferPx > mxY) mxY = p.y + bufferPx;
  }
  mnX -= res; mnY -= res; mxX += res; mxY += res;
  const cols = Math.ceil((mxX - mnX) / res) + 2;
  const rows = Math.ceil((mxY - mnY) / res) + 2;
  if (cols * rows > MAX_CELLS) return null;
  const data = new Uint8Array(cols * rows);
  const r2 = bufferPx * bufferPx;
  for (const pt of pts) {
    const cx = Math.floor((pt.x - mnX) / res);
    const cy = Math.floor((pt.y - mnY) / res);
    const rC = Math.ceil(bufferPx / res) + 1;
    for (let dy = -rC; dy <= rC; dy++) {
      for (let dx = -rC; dx <= rC; dx++) {
        const gx = cx + dx, gy = cy + dy;
        if (gx < 0 || gx >= cols || gy < 0 || gy >= rows) continue;
        const wx = mnX + gx * res - pt.x;
        const wy = mnY + gy * res - pt.y;
        if (wx * wx + wy * wy <= r2) data[gy * cols + gx] = 1;
      }
    }
  }
  return { data, cols, rows, originX: mnX, originY: mnY, res };
}

/**
 * Extracts contour line segments from a binary raster using marching squares.
 * Returns [x1,y1,x2,y2] segments in the same coordinate space as the input.
 *
 * Cell corner convention (row increases upward in grid space):
 *   idx = (tl<<3) | (tr<<2) | (br<<1) | bl
 * Edge midpoints: L=left, R=right, B=bottom, T=top of cell.
 */
export function marchingSquares(bg: BufferGrid): Array<[number, number, number, number]> {
  const { data, cols, rows, originX, originY, res } = bg;
  const segs: Array<[number, number, number, number]> = [];
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const bl = data[row * cols + col];
      const br = data[row * cols + col + 1];
      const tl = data[(row + 1) * cols + col];
      const tr = data[(row + 1) * cols + col + 1];
      const idx = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (idx === 0 || idx === 15) continue;
      const x = originX + col * res, y = originY + row * res, h = res * 0.5;
      const Lx = x,       Ly = y + h;
      const Rx = x + res, Ry = y + h;
      const Bx = x + h,   By = y;
      const Tx = x + h,   Ty = y + res;
      switch (idx) {
        case  1: case 14: segs.push([Lx, Ly, Bx, By]); break;
        case  2: case 13: segs.push([Bx, By, Rx, Ry]); break;
        case  3: case 12: segs.push([Lx, Ly, Rx, Ry]); break;
        case  4: case 11: segs.push([Tx, Ty, Rx, Ry]); break;
        case  5: segs.push([Lx, Ly, Bx, By], [Tx, Ty, Rx, Ry]); break;
        case  6: case  9: segs.push([Bx, By, Tx, Ty]); break;
        case  7: case  8: segs.push([Lx, Ly, Tx, Ty]); break;
        case 10: segs.push([Lx, Ly, Tx, Ty], [Bx, By, Rx, Ry]); break;
      }
    }
  }
  return segs;
}
