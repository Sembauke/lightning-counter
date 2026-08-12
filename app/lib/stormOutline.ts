// Pure geometry utilities for storm buffer outlines. No DOM/canvas dependency
// so these can be unit-tested in Node.

export interface Point { x: number; y: number }

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
