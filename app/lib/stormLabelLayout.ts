export interface LabelBox { x: number; y: number; width: number; height: number }

/** Keep confirmed identities visible instead of discarding nearby badges. */
export function placeStormLabel(
  desired: LabelBox,
  placed: LabelBox[],
  viewport: { width: number; height: number },
): LabelBox {
  const inset = 6;
  const constrain = (box: LabelBox): LabelBox => ({ ...box,
    x: Math.max(inset, Math.min(box.x, viewport.width - box.width - inset)),
    y: Math.max(inset, Math.min(box.y, viewport.height - box.height - inset)),
  });
  const overlap = (a: LabelBox, b: LabelBox) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width + inset) - Math.max(a.x, b.x - inset))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height + inset) - Math.max(a.y, b.y - inset));
  let best = constrain(desired), bestOverlap = Infinity;
  const rows = Math.ceil(viewport.height / (desired.height + inset));
  for (const dx of [0, -desired.width - 18, desired.width + 18]) {
    for (let row = 0; row <= rows; row++) {
      for (const direction of row === 0 ? [1] : [1, -1]) {
        const candidate = constrain({ ...desired,
          x: desired.x + dx, y: desired.y + row * direction * (desired.height + inset) });
        const area = placed.reduce((sum, box) => sum + overlap(candidate, box), 0);
        if (area === 0) return candidate;
        if (area < bestOverlap) { bestOverlap = area; best = candidate; }
      }
    }
  }
  // Extremely crowded views still retain every confirmed identity.
  return best;
}
