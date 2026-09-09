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
export const STORM_OBSERVATION_GAP_MS = 90_000;
