**Website audit — 9 September 2026**

Originally reviewed commit `f846084120850bfc816016d21dfd0c991a727a9f` and the live website. The remaining findings affect recording after startup and map history. Findings retain their original numbers as verified fixes are removed.

The review combined Chrome desktop/mobile navigation, ordinary production API requests, source inspection, and disposable SQLite reproductions. Production was not restarted or load-tested. The live bundle contains the recent shared transition display code, although bundle markers alone do not establish an exact deployed commit. Local findings below identify their reproduction boundaries explicitly.

4. **High priority: recording after server startup depends on a visitor opening the strike stream.**

   The custom server starts upstream connections immediately, but the processing function and persistence timers are registered only when `/api/strikes` loads. Both the startup prewarm and the Docker health check request `/`, which does not execute browser JavaScript or open that stream. Incoming strikes remain in an unbounded memory queue until initialization.

   Executing the actual server body with framework, transport, and timer stubs showed two connected sources, a homepage prewarm, no registered processor, and 600 queued strikes. A separate test of the actual route initialized 20 minutes after those strikes: the global total became **600**, but the raw archive and tracked storm history were both **empty**. The ten-minute admission cutoff discarded the queued locations/times from those paths. A restart before queue processing would also lose the queue itself.

   This was a controlled startup reproduction, not a production restart or a measurement of past production downtime. Its impact depends on whether a browser or another service promptly opens `/api/strikes` after startup.

   Source: [server startup and queue](../server.mjs), lines 61–68 and 132–174; [route initialization](../app/api/strikes/route.ts), lines 70–110; [health check](../docker-compose.nas.yml). Repair direction: initialize ingestion explicitly during server startup and check processor readiness independently of webpage availability.

5. **Medium priority, confirmed on production: zooming out silently removes older map history.**

   The map requests 30 minutes of strikes, but the viewport query returns only the newest 20,000 matches. The response has no pagination or indication that it is incomplete. The client replaces its historical buffer with that response.

   Two ordinary requests to the live [viewport API](https://lightning-stats.com/api/grid/viewport), with the same time cutoff, demonstrated the difference: the world view returned exactly **20,000 points**; the Europe view returned 16,139, including **288 older points missing from the world response**. Both responses were HTTP 200 and dynamically served. This is an API data omission, independent of outline drawing.

   A bounded local reproduction stored 30,000 strikes across 29 minutes. Requesting the 30-minute viewport returned only 20,000 covering about 19.33 minutes: **10,000 strikes and almost ten minutes of history were silently omitted**. Initial stream history cannot restore all of that older data.

   Source: [viewport query](../app/lib/db.ts), lines 1463–1475; [API response](../app/api/grid/viewport/route.ts); [client buffer replacement](../app/components/LightningMap.tsx), lines 284–302. Repair direction: bounded pagination or geographic subdivision with a stable time cutoff and explicit completeness information. Raising the limit alone moves the failure threshold. Guard against obsolete viewport responses overwriting newer ones.

**Additional findings and risks**

- **Country detail totals freeze after loading — production confirmed.** On [Italy's archive page](https://lightning-stats.com/stats/IT), Today stayed at 139,345 for 61 seconds while the API increased from 139,354 to 139,477. The country page fetches its data only once. Add refresh behavior comparable to the main archive. Source: [CountryClient](../app/stats/[code]/CountryClient.tsx), lines 38–50.
- **Storm detail pages fail initial hydration in other timezones — production confirmed.** The same finished storm loaded without errors in a UTC browser, but produced React hydration errors in Europe/Amsterdam: server-rendered 07:42–08:41 became 09:42–10:41 in the browser. React rebuilt the root on the client; the page and replay remained usable afterward. Format the initial render consistently, then apply the viewer's timezone after mounting. Sources: [fmtClock](../app/lib/format.ts), lines 18–21; [storm timeline labels](../app/storms/[key]/StormDetailClient.tsx), lines 415–416.
- **Restart durability gap — locally reproduced.** Counter persistence runs every 30 seconds and the custom server has no shutdown flush. A module reload restored a durable total of 250 after the live total had reached 300, losing 50 unflushed increments. Raw archival has a separate five-second batch window. Orderly shutdown flushing would reduce deployment loss; crash recovery needs durable ingestion/reconciliation rather than only shutdown handlers. Sources: [persistence timers](../app/api/strikes/route.ts), lines 413–417 and 669–675; [server](../server.mjs).
- **Daily records use delivery date, not discharge date — locally reproduced.** A valid strike at 23:59:59 delivered at 00:00:01 was credited entirely to the following UTC date. This matters around reconnects and midnight. Confirm the intended meaning of daily totals before changing this behavior; there is no justified blanket historical correction from this test alone. Source: [processStrike](../app/api/strikes/route.ts), lines 70–92.
- **Framework security maintenance needs attention.** [package.json](../package.json) and the lockfile pin Next.js 14.2.5. `npm audit` reported 14 affected dependency entries, including development dependencies and feature-dependent advisories. Next's maintainers list this version in affected ranges for [Server Components denial of service](https://github.com/vercel/next.js/security/advisories/GHSA-8h8q-6873-q5fj). A tested framework upgrade is warranted. No exploit was attempted against production, and the audit's critical package rating is not evidence that every listed vulnerability applies to this deployment.
- **Upstream TLS verification is disabled.** `rejectUnauthorized: false` in [server.mjs](../server.mjs), line 83, disables certificate validation on both lightning feeds. Restore verification after checking the upstream certificate chain. This is a confirmed configuration weakness, not evidence that incoming lightning data has been tampered with.
- **Archive queries can block the server under larger workloads.** Public grid queries accept very wide bounds, arbitrary old cutoffs, and large offsets. With one million rows in isolated SQLite, an area request returning 25 rows took about 408 ms on page one and 1,019 ms at a large offset, synchronously on the request thread. Bound inputs, use suitable indexes/cursors, and assess ingestion isolation. These measurements are a scaling risk, not a demonstrated production outage. Sources: [area API](../app/api/grid/area/route.ts), [database queries](../app/lib/db.ts), lines 1490–1505.

**Validation and scope**

The original audit suite passed: **267 tests in 26 files**. The current suite passes **314 tests in 35 files**, and TypeScript passes with `--noEmit --incremental false`. The temporary audit fixtures record the original defective behavior; current regression coverage lives in `__tests__`.

Desktop Chrome at 1500 px and mobile Chrome emulation at 390 px covered the homepage, archive, daily totals, country pages, storm list, active and finished storm details, replay controls, records, navigation, and saved preferences. The tested mobile pages had no horizontal overflow. Daily Totals remained selected after reload, its counts updated, and the Dutch locale persisted. Playback advanced and controls responded in the sampled finished storm. Hydration errors on storm detail pages are documented separately in the browser evidence; the pages recovered and remained usable.

The review did not observe an entire five-minute split/merge cycle on production, access production logs, or compare every stored record against an external source. Local deterministic tests cover the lifecycle findings. The magnitude of existing historical damage remains unknown.

Original reproduction scripts, compact result JSON, and screenshots are under `/tmp/lightning-website-audit-2026-09-09/` on this machine. Those scripts target the audited commit and may intentionally fail after the relevant defect is fixed.

Suggested implementation order for remaining work: make startup and persistence independent of visitors; then repair viewport completeness and stale page totals. Address the framework upgrade alongside those changes with appropriate compatibility checks. Existing user changes in `app/globals.css` and `tsconfig.tsbuildinfo` were left untouched.
