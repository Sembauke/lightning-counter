import { describe, it, expect } from 'vitest';
import { buildGeographicOutline, densityCore, rasteriseBuffer, marchingSquares } from '../app/lib/stormOutline';

describe('densityCore', () => {
  it('returns the single point when given one point', () => {
    const core = densityCore([{ x: 42, y: 17 }], 10);
    expect(core.x).toBeCloseTo(42);
    expect(core.y).toBeCloseTo(17);
  });

  it('picks the denser cluster when two clusters exist', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, // 3 pts in one cell
      { x: 200, y: 200 },                                 // 1 isolated pt
    ];
    const core = densityCore(pts, 10);
    expect(core.x).toBeLessThan(100);
    expect(core.y).toBeLessThan(100);
  });

  it('handles two equal-size clusters and picks one of them', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 1, y: 0 },    // cell A
      { x: 100, y: 0 }, { x: 101, y: 0 }, // cell B
    ];
    const core = densityCore(pts, 10);
    // Core must be in one of the two clusters, not in the empty space between
    const nearA = Math.hypot(core.x - 0.5, core.y) < 50;
    const nearB = Math.hypot(core.x - 100.5, core.y) < 50;
    expect(nearA || nearB).toBe(true);
  });

  it('returns {0,0} for empty input', () => {
    const core = densityCore([], 10);
    expect(core).toEqual({ x: 0, y: 0 });
  });
});

describe('geographic storm outlines', () => {
  const reference = { lat: 44, lon: 10 };
  const worldKm = 40_075.016686 * Math.cos(reference.lat * Math.PI / 180);
  const nx = (reference.lon + 180) / 360;
  const separated = [
    ...Array.from({ length: 20 }, () => reference),
    ...Array.from({ length: 12 }, () => ({ lat: 44, lon: 10 + 25 / worldKm * 360 })),
    { lat: 44, lon: 10 + 70 / worldKm * 360 },
  ];

  it('uses a ten-kilometre buffer, including at the latitude of the reported storm', () => {
    const outline = buildGeographicOutline([reference], reference)!;
    expect(outline.extentKm).toBeCloseTo(10, 8);
    expect(outline.resolutionKm).toBe(1);
    const distances = outline.segments.flatMap(([ax, , bx]) => [
      Math.abs(ax - nx) * worldKm, Math.abs(bx - nx) * worldKm,
    ]);
    expect(Math.max(...distances)).toBeGreaterThan(9);
    expect(Math.max(...distances)).toBeLessThanOrEqual(10.5);
  });

  it('keeps two active patches 25 km apart distinct without labeling isolated strikes', () => {
    const outline = buildGeographicOutline(separated, reference)!;
    expect(outline.cores.map(core => core.count)).toEqual([20, 12]);
    expect((outline.cores[1].nx - outline.cores[0].nx) * worldKm).toBeCloseTo(25, 6);
    expect(outline.core).toEqual({ nx: outline.cores[0].nx, ny: outline.cores[0].ny });
    // Neither contour reaches the empty midpoint between the first two cells.
    const midpoint = nx + 12.5 / worldKm;
    expect(outline.segments.every(([ax, , bx]) => (ax - midpoint) * (bx - midpoint) > 0)).toBe(true);
  });

  it('combines patches only when their geographic buffers actually overlap', () => {
    const points = [
      ...Array.from({ length: 20 }, () => reference),
      ...Array.from({ length: 12 }, () => ({ lat: 44, lon: 10 + 15 / worldKm * 360 })),
    ];
    const outline = buildGeographicOutline(points, reference)!;
    expect(outline.cores.map(core => core.count)).toEqual([32]);
  });

  it('projects identical contour topology and cores across zoom levels and pans', () => {
    const outline = buildGeographicOutline(separated, reference)!;
    for (const zoom of [3, 6, 8, 12, 18]) {
      for (const offset of [-1200, 0, 750]) {
        const scale = 256 * 2 ** zoom;
        const screenSegments = outline.segments.map(segment => segment.map(value => value * scale + offset));
        const recovered = screenSegments.map(segment => segment.map(value => (value - offset) / scale));
        expect(recovered).toHaveLength(outline.segments.length);
        for (let index = 0; index < recovered.length; index++) {
          recovered[index].forEach((value, axis) => expect(value).toBeCloseTo(outline.segments[index][axis], 12));
        }
        expect(outline.cores.map(core => core.count)).toEqual([20, 12]);
      }
    }
  });

  it('retains outlines whose high-zoom pixel bounding box exceeds the old raster guard', () => {
    const points = [{ lat: 43, lon: 9 }, { lat: 45, lon: 11 }];
    const outline = buildGeographicOutline(points, reference)!;
    expect(outline.segments.length).toBeGreaterThan(0);
    expect(outline.resolutionKm).toBe(1);
    // At z12 the old screen-coordinate grid exceeded its 250,000-cell limit.
    const scale = 256 * 2 ** 12 / worldKm;
    expect(rasteriseBuffer([{ x: 0, y: 0 }, { x: 160 * scale, y: 222 * scale }], 10 * scale)).toBeNull();
  });

  it('scales ground distances at high latitude', () => {
    const highReference = { lat: 75, lon: 10 };
    const highWorldKm = 40_075.016686 * Math.cos(75 * Math.PI / 180);
    const points = [
      ...Array.from({ length: 10 }, () => highReference),
      ...Array.from({ length: 10 }, () => ({ lat: 75, lon: 10 + 25 / highWorldKm * 360 })),
    ];
    const outline = buildGeographicOutline(points, highReference)!;
    expect(outline.cores).toHaveLength(2);
    expect(outline.extentKm).toBeCloseTo(35, 6);
  });

  it('keeps a date-line storm local and connected', () => {
    const points = [
      ...Array.from({ length: 10 }, () => ({ lat: 44, lon: 179.95 })),
      ...Array.from({ length: 10 }, () => ({ lat: 44, lon: -179.95 })),
    ];
    const outline = buildGeographicOutline(points, { lat: 44, lon: 179.95 })!;
    expect(outline.cores.map(core => core.count)).toEqual([20]);
    expect(outline.resolutionKm).toBe(1);
    const xs = outline.segments.flatMap(([ax, , bx]) => [ax, bx]);
    expect((Math.max(...xs) - Math.min(...xs)) * worldKm).toBeLessThan(30);
    expect(xs.some(x => x > 1)).toBe(true);
  });

  it('ignores invalid points and rejects unusable references and distances', () => {
    expect(buildGeographicOutline([], reference)).toBeNull();
    expect(buildGeographicOutline([{ lat: NaN, lon: 10 }, { lat: 91, lon: 10 }], reference)).toBeNull();
    expect(buildGeographicOutline([reference], { lat: Infinity, lon: 10 })).toBeNull();
    expect(buildGeographicOutline([reference], reference, 0)).toBeNull();
    expect(buildGeographicOutline([reference], reference, 10, -1)).toBeNull();
  });
});

describe('rasteriseBuffer', () => {
  it('returns null for empty input', () => {
    expect(rasteriseBuffer([], 10)).toBeNull();
  });

  it('marks the point cell itself as inside', () => {
    const bg = rasteriseBuffer([{ x: 50, y: 50 }], 20, 4)!;
    expect(bg).not.toBeNull();
    const cx = Math.floor((50 - bg.originX) / bg.res);
    const cy = Math.floor((50 - bg.originY) / bg.res);
    expect(bg.data[cy * bg.cols + cx]).toBe(1);
  });

  it('two nearby points (< 2×bufferPx apart) produce a merged region at midpoint', () => {
    const bg = rasteriseBuffer([{ x: 0, y: 0 }, { x: 15, y: 0 }], 20, 4)!;
    expect(bg).not.toBeNull();
    const cx = Math.floor((7 - bg.originX) / bg.res);
    const cy = Math.floor((0 - bg.originY) / bg.res);
    expect(bg.data[cy * bg.cols + cx]).toBe(1);
  });

  it('two distant points (> 2×bufferPx apart) leave a gap at midpoint', () => {
    const bg = rasteriseBuffer([{ x: 0, y: 0 }, { x: 200, y: 0 }], 20, 4)!;
    expect(bg).not.toBeNull();
    const cx = Math.floor((100 - bg.originX) / bg.res);
    const cy = Math.floor((0 - bg.originY) / bg.res);
    expect(bg.data[cy * bg.cols + cx]).toBe(0);
  });

  it('returns null when the grid would exceed the size limit', () => {
    const result = rasteriseBuffer([{ x: 0, y: 0 }, { x: 10_000, y: 10_000 }], 5, 1);
    expect(result).toBeNull();
  });
});

describe('marchingSquares', () => {
  it('produces no segments for an all-zero grid', () => {
    const bg = { data: new Uint8Array(4), cols: 2, rows: 2, originX: 0, originY: 0, res: 4 };
    expect(marchingSquares(bg)).toHaveLength(0);
  });

  it('produces no segments for an all-one grid', () => {
    const bg = { data: new Uint8Array([1, 1, 1, 1]), cols: 2, rows: 2, originX: 0, originY: 0, res: 4 };
    expect(marchingSquares(bg)).toHaveLength(0);
  });

  it('case 1 (bottom-left only) produces exactly one segment', () => {
    // 3×3 grid: only cell (row=0, col=0) is inside
    const data = new Uint8Array(9);
    data[0] = 1;
    const bg = { data, cols: 3, rows: 3, originX: 0, originY: 0, res: 4 };
    const segs = marchingSquares(bg);
    expect(segs).toHaveLength(1);
  });

  it('case 15 complement (only tl=1) produces two segments', () => {
    // Grid:  row1=[1,0,0]  row0=[0,0,0]
    // The set cell appears as tl in the (row=0,col=0) cell → case 8 (L→T),
    // and as bl in the (row=1,col=0) cell → case 1 (L→B): two segments total.
    const data = new Uint8Array(9);
    data[3] = 1; // row=1, col=0
    const bg = { data, cols: 3, rows: 3, originX: 0, originY: 0, res: 4 };
    const segs = marchingSquares(bg);
    expect(segs).toHaveLength(2);
  });

  it('a single circular buffer region produces a closed-looking boundary', () => {
    const bg = rasteriseBuffer([{ x: 50, y: 50 }], 20, 4)!;
    const segs = marchingSquares(bg);
    // Circle of radius 20 with res=4 → perimeter ≈ 2π×20/4 ≈ 31 cells → 31+ segments
    expect(segs.length).toBeGreaterThan(20);
  });

  it('two merged points produce more segments than one point alone', () => {
    const bgOne = rasteriseBuffer([{ x: 50, y: 50 }], 20, 4)!;
    const bgTwo = rasteriseBuffer([{ x: 50, y: 50 }, { x: 70, y: 50 }], 20, 4)!;
    expect(marchingSquares(bgTwo).length).toBeGreaterThan(marchingSquares(bgOne).length);
  });

  it('two separate regions produce independent contours (more segments than merged)', () => {
    const bgMerged = rasteriseBuffer([{ x: 0, y: 0 }, { x: 30, y: 0 }], 20, 4)!;
    const bgSeparate = rasteriseBuffer([{ x: 0, y: 0 }, { x: 200, y: 0 }], 20, 4)!;
    // Two circles = roughly 2× the perimeter of one merged blob
    expect(marchingSquares(bgSeparate).length).toBeGreaterThan(marchingSquares(bgMerged).length);
  });
});
