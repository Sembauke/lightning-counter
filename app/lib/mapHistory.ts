/** The live map displays one fixed hour across every history page. */
export const MAP_HISTORY_WINDOW_MS = 60 * 60_000;
export const MAP_HISTORY_PAGE_SIZE = 10_000;

export interface MapHistoryBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface MapHistoryStrike {
  id: number;
  lat: number;
  lon: number;
  strike_time: number;
}

export interface MapHistoryPage {
  strikes: MapHistoryStrike[];
  nextCursor: string | null;
  complete: boolean;
  since: number;
  until: number;
}
