import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Lightning Stats — real-time global lightning tracker';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(160deg, #0a0a0f 60%, #16121f 100%)',
          color: 'rgba(255,230,80,0.92)',
        }}
      >
        <div style={{ fontSize: 140, display: 'flex' }}>⚡</div>
        <div
          style={{
            fontSize: 72,
            fontWeight: 700,
            letterSpacing: '0.1em',
            display: 'flex',
            textTransform: 'uppercase',
          }}
        >
          Lightning Stats
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 32,
            color: 'rgba(255,255,255,0.75)',
            display: 'flex',
          }}
        >
          Real-time global lightning map & strike tracker
        </div>
      </div>
    ),
    { ...size },
  );
}
