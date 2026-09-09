**Website audit — 9 September 2026**

Originally reviewed commit `f846084120850bfc816016d21dfd0c991a727a9f` and the live website. Verified fixes have been removed; the remaining findings are listed below.

The review combined Chrome desktop/mobile navigation, ordinary production API requests, source inspection, and disposable SQLite reproductions. Production was not restarted or load-tested. The live bundle contains the recent shared transition display code, although bundle markers alone do not establish an exact deployed commit. Local findings below identify their reproduction boundaries explicitly.

**Remaining findings and risks**

- **Framework security maintenance needs attention.** [package.json](../package.json) and the lockfile pin Next.js 14.2.5. `npm audit` reported 14 affected dependency entries, including development dependencies and feature-dependent advisories. Next's maintainers list this version in affected ranges for [Server Components denial of service](https://github.com/vercel/next.js/security/advisories/GHSA-8h8q-6873-q5fj). A tested framework upgrade is warranted. No exploit was attempted against production, and the audit's critical package rating is not evidence that every listed vulnerability applies to this deployment.
- **Archive queries can block the server under larger workloads.** Public grid queries accept very wide bounds, arbitrary old cutoffs, and large offsets. With one million rows in isolated SQLite, an area request returning 25 rows took about 408 ms on page one and 1,019 ms at a large offset, synchronously on the request thread. Bound inputs, use suitable indexes/cursors, and assess ingestion isolation. These measurements are a scaling risk, not a demonstrated production outage. Sources: [area API](../app/api/grid/area/route.ts), [database queries](../app/lib/db.ts), lines 1490–1505.

**Validation and scope**

The original audit suite passed: **267 tests in 26 files**. The current suite passes **383 tests in 45 files**, and TypeScript passes with `--noEmit --incremental false`. The temporary audit fixtures record the original defective behavior; current regression coverage lives in `__tests__`.

Desktop Chrome at 1500 px and mobile Chrome emulation at 390 px covered the homepage, archive, daily totals, country pages, storm list, active and finished storm details, replay controls, records, navigation, and saved preferences. The tested mobile pages had no horizontal overflow. Daily Totals remained selected after reload, its counts updated, and the Dutch locale persisted. Playback advanced and controls responded in the sampled finished storm. Hydration errors on storm detail pages are documented separately in the browser evidence; the pages recovered and remained usable.

The review did not observe an entire five-minute split/merge cycle on production, access production logs, or compare every stored record against an external source. Local deterministic tests cover the lifecycle findings. The magnitude of existing historical damage remains unknown.

Original reproduction scripts, compact result JSON, and screenshots are under `/tmp/lightning-website-audit-2026-09-09/` on this machine. Those scripts target the audited commit and may intentionally fail after the relevant defect is fixed.

The remaining work covers framework maintenance and archive query isolation. Existing user changes in `app/globals.css` and `tsconfig.tsbuildinfo` were left untouched.
