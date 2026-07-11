// Shared strike-age gradient: t=0 → oldest (dark purple), t=1 → newest (yellow).
// Used by the live map's dot layer and the biggest-storm replay.

type Stop = [pos: number, r: number, g: number, b: number, a: number];

const STOPS: Stop[] = [
  [0,    30,   0,   80, 0.20],
  [0.30, 120,  0,  160, 0.42],
  [0.55, 210,  10,  10, 0.65],
  [0.78, 255, 120,   0, 0.80],
  [1,    255, 230,   0, 0.92],
];

export function ageColor(t: number): [number, number, number, number] {
  let i = 0;
  while (i < STOPS.length - 2 && STOPS[i + 1][0] <= t) i++;
  const s0 = STOPS[i], s1 = STOPS[i + 1];
  const f = s1[0] > s0[0] ? (t - s0[0]) / (s1[0] - s0[0]) : 0;
  return [
    Math.round(s0[1] + f * (s1[1] - s0[1])),
    Math.round(s0[2] + f * (s1[2] - s0[2])),
    Math.round(s0[3] + f * (s1[3] - s0[3])),
    +(s0[4] + f * (s1[4] - s0[4])).toFixed(2),
  ];
}
