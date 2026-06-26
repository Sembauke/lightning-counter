'use client';

const BANDS = [
  { color: '#ffffff', label: '< 10 sec' },
  { color: '#ffff00', label: '< 1 min' },
  { color: '#ffcc00', label: '1–5 min' },
  { color: '#ff8800', label: '5–15 min' },
  { color: '#ff4400', label: '15–30 min' },
];

export default function ColorLegend() {
  return (
    <div className="legend">
      {BANDS.map(({ color, label }) => (
        <div key={label} className="legend-item">
          <span className="legend-dot" style={{ background: color, boxShadow: `0 0 4px ${color}` }} />
          <span className="legend-text">{label}</span>
        </div>
      ))}
    </div>
  );
}
