export interface StormTransitionPoint { nx: number; ny: number }

/** Server-observed contact/separation, confirmed only by a later tracking pass. */
export interface StormTransition {
  id: string;
  kind: 'split' | 'merge';
  startedAt: number;
  confirmAt: number;
  observedAt: number;
  stormKeys: string[];
  links: Array<{ from: StormTransitionPoint; to: StormTransitionPoint }>;
}

export const STORM_TRANSITION_MS = 5 * 60_000;
/** Widely separated outline groups need less time to confirm a split. */
export const STORM_DISTANT_SPLIT_MS = 60_000;
export const STORM_DISTANT_SPLIT_KM = 50;
export const STORM_OBSERVATION_GAP_MS = 90_000;
