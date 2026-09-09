import type { MapHistoryBounds, MapHistoryStrike } from './mapHistory';

export const GRID_ARCHIVE_WINDOW_MS = 3 * 24 * 60 * 60_000;
export const GRID_ARCHIVE_PAGE_SIZE = 25;

export interface GridArchiveQuery {
  kind: 'viewport' | 'area' | 'cell';
  bounds?: MapHistoryBounds;
  cellId?: string;
  since: number;
  until: number;
  limit: number;
  snapshotId?: number;
  after?: { strikeTime: number; id: number };
  total?: number;
}

export interface GridArchiveResult {
  strikes: MapHistoryStrike[];
  snapshotId: number;
  next: { strikeTime: number; id: number } | null;
  total?: number;
  cell?: { cell_id: string; total_strikes: number; last_strike_time: number | null } | null;
}

export interface GridArchivePage {
  strikes: MapHistoryStrike[];
  total: number;
  page: number;
  pages: number;
  limit: number;
  since: number;
  until: number;
  nextCursor: string | null;
}
