export function fmt(n: number): string {
  return n.toLocaleString();
}

/** Strike rate: one decimal below 10/m, whole numbers above */
export function fmtRate(r: number): string {
  return r >= 10 ? String(Math.round(r)) : r.toFixed(1);
}

/** Duration in ms as "2h 14m" / "45m" */
export function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Epoch ms as the viewer's local wall-clock time */
export function fmtClock(t: number, seconds = false): string {
  return new Date(t).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
  });
}
