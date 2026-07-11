import Link from 'next/link';
import HomeClient from './components/HomeClient';
import { SITE_URL } from './lib/site';

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'How does the live lightning map work?',
    a: 'The map shows lightning discharges detected by Blitzortung.org, a community network of thousands of volunteer-run receiver stations. Each station records the radio signal a discharge emits, and the network locates the strike from the tiny differences in arrival time. New strikes appear on the map within seconds.',
  },
  {
    q: 'How real-time is the data?',
    a: 'Strikes typically appear one to a few seconds after they happen. The map always shows the last 30 minutes of activity, with the newest discharges drawn brightest and on top.',
  },
  {
    q: 'What do the dot colors mean?',
    a: 'Color encodes age within the 30-minute window: bright yellow dots are the most recent strikes, fading through orange and red to dark purple for the oldest. Strikes younger than ten seconds get a red ring.',
  },
  {
    q: 'What is Blitzortung.org?',
    a: 'Blitzortung.org is a non-commercial, community-driven lightning detection network. Volunteers around the world operate low-cost receiver hardware, and the project combines their measurements into free, real-time lightning data.',
  },
  {
    q: 'Is Lightning Stats free to use?',
    a: 'Yes. Lightning Stats is completely free — no account, no ads. It exists because watching storms live is fascinating.',
  },
];

export default function Home() {
  return (
    <>
      <HomeClient />
      <section className="site-info">
        <h1>Real-Time Global Lightning Map & Discharge Tracker</h1>
        <p>
          Lightning Stats shows every lightning discharge on Earth as it happens, using live data
          from the <a href="https://www.blitzortung.org" target="_blank" rel="noreferrer">Blitzortung.org</a>{' '}
          community detection network. The map keeps a rolling 30-minute window: fresh strikes flash
          in bright yellow with an expanding ring, then fade toward red as they age.
        </p>
        <p>
          The map is drawn over live satellite imagery, and you can switch on a density heatmap
          grid with per-cell strike counts, a wind-flow layer, and sound alerts that tick for
          every discharge in view. The <Link href="/stats">discharge archive</Link> ranks live
          totals by country and keeps daily counts, all-time records, and a browsable history
          for every country.
        </p>

        <h2>Frequently asked questions</h2>
        {FAQ.map(({ q, a }) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              url: SITE_URL,
              mainEntity: FAQ.map(({ q, a }) => ({
                '@type': 'Question',
                name: q,
                acceptedAnswer: { '@type': 'Answer', text: a },
              })),
            }),
          }}
        />
      </section>
    </>
  );
}
