import { STORM_OBSERVATION_GAP_MS, type StormTransition } from './stormTransition';

// Tracker snapshots normally arrive every 30 seconds. An expired countdown
// cannot confirm an identity change while the server evidence is stale.
export const STORM_TRANSITION_STALE_MS = STORM_OBSERVATION_GAP_MS;

export function transitionLabel(transition: StormTransition, now: number, connected = true): string {
  const action = transition.kind === 'split' ? 'Split' : 'Merge';
  if (!connected || now - transition.observedAt > STORM_TRANSITION_STALE_MS) {
    return `${action} · waiting for update`;
  }
  const seconds = Math.max(0, Math.ceil((transition.confirmAt - now) / 1000));
  if (seconds === 0) return `Confirming ${transition.kind}…`;
  return `${action} ${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function isTransition(value: unknown): value is StormTransition {
  if (!value || typeof value !== 'object') return false;
  const transition = value as StormTransition;
  return typeof transition.id === 'string' && transition.id.length > 0
    && (transition.kind === 'split' || transition.kind === 'merge')
    && Number.isFinite(transition.startedAt) && Number.isFinite(transition.confirmAt)
    && Number.isFinite(transition.observedAt) && transition.confirmAt >= transition.startedAt
    && Array.isArray(transition.stormKeys) && transition.stormKeys.length > 0
    && transition.stormKeys.every(key => typeof key === 'string' && key.length > 0)
    && Array.isArray(transition.links) && transition.links.every(link =>
      link && Number.isFinite(link.from?.nx) && Number.isFinite(link.from?.ny)
      && Number.isFinite(link.to?.nx) && Number.isFinite(link.to?.ny));
}

/** null means malformed input; an empty map is an authoritative cancellation. */
export function collectStormTransitions(snapshot: unknown): Map<string, StormTransition> | null {
  if (!Array.isArray(snapshot)) return null;
  const events = new Map<string, StormTransition>();
  for (const storm of snapshot) {
    if (!storm || typeof storm !== 'object') return null;
    if (storm.transitions === undefined) continue;
    if (!Array.isArray(storm.transitions) || !storm.transitions.every(isTransition)) return null;
    for (const transition of storm.transitions as StormTransition[]) {
      const previous = events.get(transition.id);
      if (!previous || transition.observedAt > previous.observedAt) events.set(transition.id, transition);
    }
  }
  const result = new Map<string, StormTransition>();
  for (const transition of events.values()) {
    for (const key of transition.stormKeys) {
      const previous = result.get(key);
      if (!previous || transition.observedAt > previous.observedAt
        || (transition.observedAt === previous.observedAt && transition.id < previous.id)) {
        result.set(key, transition);
      }
    }
  }
  return result;
}
