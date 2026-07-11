export function fmt(n: number): string {
  return n.toLocaleString();
}

/** Strike rate: one decimal below 10/m, whole numbers above */
export function fmtRate(r: number): string {
  return r >= 10 ? String(Math.round(r)) : r.toFixed(1);
}

/** Epoch ms as the viewer's local wall-clock time */
export function fmtClock(t: number, seconds = false): string {
  return new Date(t).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
  });
}
