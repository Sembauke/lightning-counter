export function fmt(n: number): string {
  return n.toLocaleString();
}

/** Strike rate: one decimal below 10/m, whole numbers above */
export function fmtRate(r: number): string {
  return r >= 10 ? String(Math.round(r)) : r.toFixed(1);
}
