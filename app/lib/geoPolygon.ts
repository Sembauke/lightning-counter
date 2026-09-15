// Ray casting for a ring of [longitude, latitude] vertices, including its boundary.
export function containsPoint(ring: number[][], lat: number, lon: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      (lon - xi) * (yj - yi) === (lat - yi) * (xj - xi)
      && lon >= Math.min(xi, xj) && lon <= Math.max(xi, xj)
      && lat >= Math.min(yi, yj) && lat <= Math.max(yi, yj)
    ) return true;
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
