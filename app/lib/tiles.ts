// Shared basemap sources (ESRI World Imagery + reference labels)

export const TILE_SAT = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  options: { maxZoom: 19 },
};

export const TILE_LABELS_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

/** Dims satellite imagery so strike dots stay readable on top */
export const TILE_DIM_FILTER = 'brightness(0.55)';
