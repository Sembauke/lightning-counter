import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { withStormLocationNames } from '../../lib/stormLocation';
import { getStormName } from '../../lib/stormName';
import styles from './page.module.css';

export const metadata: Metadata = {
  title: 'Storm Locations Demo',
  robots: { index: false, follow: false },
};

const examples = [
  { kind: 'Sea', code: 'XO', country: 'Ocean', city: 'Open Ocean', lat: 56, lon: 3 },
  { kind: 'Sea', code: 'XO', country: 'Ocean', city: 'Open Ocean', lat: 34, lon: 18 },
  { kind: 'Ocean', code: 'XO', country: 'Ocean', city: 'Open Ocean', lat: 40, lon: -35 },
  { kind: 'Province', code: 'NL', country: 'Netherlands', city: 'Amsterdam', lat: 52.3676, lon: 4.9041 },
  { kind: 'State', code: 'US', country: 'United States', city: 'Miami', lat: 25.774, lon: -80.194 },
  { kind: 'Province', code: 'CA', country: 'Canada', city: 'Toronto', lat: 43.6532, lon: -79.3832 },
  { kind: 'State', code: 'DE', country: 'Germany', city: 'Munich', lat: 48.1351, lon: 11.582 },
];

function coordinates(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(4)}° ${lon < 0 ? 'W' : 'E'}`;
}

export default async function StormLocationsDemo() {
  const t = await getTranslations('storms');
  const journey = {
    code: 'CA', city: 'Montreal', lat: 45.5019, lon: -73.5674,
    originCity: 'Toronto', originLat: 43.6532, originLon: -79.3832,
  };
  const namedJourney = withStormLocationNames(journey);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.badge}>Demo</span>
        <h1>Storm locations</h1>
        <p>Named seas and oceans. States, provinces and regions for storms on land.</p>
        <span className={styles.note}>Illustrative locations, using the same lookup as storm pages.</span>
      </header>

      {['At sea', 'On land'].map((heading, group) => (
        <section key={heading} className={styles.section} aria-labelledby={`group-${group}`}>
          <div className={styles.sectionHeading}>
            <h2 id={`group-${group}`}>{heading}</h2>
            <span>{group === 0 ? 'The actual body of water' : 'The region containing the storm'}</span>
          </div>
          <div className={group === 0 ? styles.seas : styles.land}>
            {examples.slice(group === 0 ? 0 : 3, group === 0 ? 3 : undefined).map(example => {
              const original = { ...example, originCity: null };
              const named = withStormLocationNames(original);
              return (
                <article className={styles.card} key={`${example.lat},${example.lon}`}>
                  <div className={styles.cardHeading}>
                    <span>{example.kind}</span>
                    <span aria-hidden="true">{example.code === 'XO' ? '≈' : '⌖'}</span>
                  </div>
                  <p className={styles.coordinates}>{coordinates(example.lat, example.lon)}</p>
                  <div className={styles.before}><span>Before</span><p>{getStormName(original, t)}</p></div>
                  <div className={styles.after}><span>After</span><h3>{getStormName(named, t)}</h3></div>
                  <details className={styles.details}>
                    <summary>Location details</summary>
                    <dl>
                      <div><dt>Country / group</dt><dd>{example.country} ({example.code})</dd></div>
                      <div><dt>Sea / ocean</dt><dd>{example.code === 'XO' ? named.city : '—'}</dd></div>
                      <div><dt>State / province / region</dt><dd>{named.subdivision ?? '—'}</dd></div>
                      <div><dt>Nearby city</dt><dd>{example.code === 'XO' ? '—' : named.city}</dd></div>
                    </dl>
                  </details>
                </article>
              );
            })}
          </div>
        </section>
      ))}

      <section className={styles.section} aria-labelledby="journey-heading">
        <div className={styles.sectionHeading}>
          <h2 id="journey-heading">Across regions</h2><span>Origin and current location stay distinct</span>
        </div>
        <article className={`${styles.card} ${styles.journey}`}>
          <div className={styles.before}><span>Before</span><p>{getStormName(journey, t)}</p></div>
          <div className={styles.after}><span>After</span><h3>{getStormName(namedJourney, t)}</h3></div>
          <div className={styles.route}>
            <div><span>Origin</span><strong>{namedJourney.originSubdivision}</strong><p>Near {namedJourney.originCity}</p><small>{coordinates(journey.originLat, journey.originLon)}</small></div>
            <span className={styles.arrow} aria-hidden="true">→</span>
            <div><span>Current location</span><strong>{namedJourney.subdivision}</strong><p>Near {namedJourney.city}</p><small>{coordinates(journey.lat, journey.lon)}</small></div>
          </div>
          <p className={styles.note}>Canada (CA) · Example journey</p>
        </article>
      </section>
      <footer className={styles.footer}>Demo examples only · No live storm activity is shown here.</footer>
    </main>
  );
}
