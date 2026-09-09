import type { StormFootprintGeometry } from './stormFootprint';
import type { StormTransition } from './stormTransition';

interface Projection { scale: number; ox: number; oy: number }

/** Indicators are anchored to the same geographic edges used by the tracker. */
export function drawStormTransitionIndicator(
  ctx: CanvasRenderingContext2D,
  transition: StormTransition,
  outlines: StormFootprintGeometry[],
  projection: Projection,
  label: string,
  now: number,
): void {
  const { scale, ox, oy } = projection;
  const color = transition.kind === 'split' ? '#5bdcff' : '#ffb13b';
  const progress = Math.max(0, Math.min(1,
    (now - transition.startedAt) / Math.max(1, transition.confirmAt - transition.startedAt)));

  for (const link of transition.links) {
    const ax = link.from.nx * scale + ox, ay = link.from.ny * scale + oy;
    const bx = link.to.nx * scale + ox, by = link.to.ny * scale + oy;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = '#090d15';
    ctx.lineWidth = 3;
    ctx.shadowColor = color;
    ctx.shadowBlur = 7;

    // Paint the nearby pieces of the real storm boundary, not its centroid.
    // An 8 km geographic highlight scales naturally with the map.
    for (const anchor of [link.from, link.to]) {
      const cosLat = 1 / Math.cosh((0.5 - anchor.ny) * 2 * Math.PI);
      const radius = 8 * scale / (40_075.016686 * cosLat);
      const x = anchor.nx * scale + ox, y = anchor.ny * scale + oy;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.beginPath();
      for (const outline of outlines) {
        for (const [x1, y1, x2, y2] of outline.segments) {
          ctx.moveTo(x1 * scale + ox, y1 * scale + oy);
          ctx.lineTo(x2 * scale + ox, y2 * scale + oy);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    // During a split this bridge makes the temporarily shared identity explicit.
    // During a merge it joins the exact contact anchors of the two outlines.
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [x, y] of [[ax, ay], [bx, by]]) {
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    const length = Math.hypot(bx - ax, by - ay);
    const ux = length > 1 ? (bx - ax) / length : 1;
    const uy = length > 1 ? (by - ay) / length : 0;
    // Opposing chevrons distinguish separating and joining even without colour.
    for (const side of [-1, 1]) {
      const direction = side * (transition.kind === 'split' ? 1 : -1);
      const x = mx + side * 11 * ux, y = my + side * 11 * uy;
      ctx.beginPath();
      ctx.moveTo(x - direction * 5 * ux - 4 * uy, y - direction * 5 * uy + 4 * ux);
      ctx.lineTo(x, y);
      ctx.lineTo(x - direction * 5 * ux + 4 * uy, y - direction * 5 * uy - 4 * ux);
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const width = ctx.measureText(label).width + 22;
    const left = mx - width / 2, top = my - 46;
    ctx.fillStyle = 'rgba(6,10,18,0.96)';
    ctx.fillRect(left, top, width, 28);
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, width, 28);
    ctx.fillStyle = color;
    ctx.fillText(label, mx, top + 12);
    ctx.globalAlpha = 0.2;
    ctx.fillRect(left + 5, top + 22, width - 10, 2);
    ctx.globalAlpha = 1;
    ctx.fillRect(left + 5, top + 22, (width - 10) * progress, 2);
    ctx.restore();
  }
}
