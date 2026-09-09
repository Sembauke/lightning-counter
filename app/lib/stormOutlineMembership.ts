interface Position { lat: number; lon: number }
interface OutlineStorm extends Position { stormKey: string | null; rank: number }

/** Nearby outline points have one visual owner; overlap never combines identities. */
export function assignOutlinePoints<S extends OutlineStorm, P extends Position>(
  storms: S[], points: P[], radiusKm = 120,
): Map<S, P[]> {
  const assigned = new Map(storms.map(storm => [storm, [] as P[]]));
  for (const point of points) {
    let owner: S | undefined;
    let nearest = radiusKm;
    for (const storm of storms) {
      const dLat = (point.lat - storm.lat) * 111.32;
      const dLon = ((point.lon - storm.lon + 540) % 360 - 180) * 111.32
        * Math.cos((point.lat + storm.lat) / 2 * Math.PI / 180);
      const km = Math.hypot(dLat, dLon);
      const key = storm.stormKey ?? `rank-${storm.rank}`;
      const ownerKey = owner?.stormKey ?? `rank-${owner?.rank}`;
      if (km < nearest || (km === nearest && (!owner || key < ownerKey))) {
        nearest = km;
        owner = storm;
      }
    }
    if (owner) assigned.get(owner)!.push(point);
  }
  return assigned;
}
