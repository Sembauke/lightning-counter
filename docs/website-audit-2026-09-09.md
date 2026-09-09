**Website audit — 9 September 2026**

Originally reviewed commit `f846084120850bfc816016d21dfd0c991a727a9f` and the live website. All findings from this audit have been addressed and removed from the outstanding list.

The review combined Chrome desktop/mobile navigation, ordinary production API requests, source inspection, and disposable SQLite reproductions. Production was not restarted or load-tested. The live bundle contains the recent shared transition display code, although bundle markers alone do not establish an exact deployed commit. Local findings below identify their reproduction boundaries explicitly.

**Outstanding findings**

None remaining from this audit. This records completion of the identified repairs, not a guarantee that the website has no other defects.

**Validation and scope**

The original audit suite passed: **267 tests in 26 files**. The final combined suite passes **397 tests in 47 files**, TypeScript passes with `--noEmit --incremental false`, and the Next.js 16.3.4 production build succeeds. A clean dependency installation reports **zero npm audit vulnerabilities**, including development dependencies. Current regression coverage lives in `__tests__`.

ESLint completes with no errors and 61 warnings, primarily existing hook dependencies and newer React Compiler diagnostics. React Compiler is not enabled; its adoption diagnostics remain warnings while the existing hook correctness rules stay enabled.

Final verification also exercised durable ingestion through actual production-server SIGTERM and SIGKILL restarts: 600 accepted strikes were recovered across the counters, raw archive, storm ownership and replay, without double counting on redelivery. Both upstream WebSocket connections succeeded with certificate verification enabled. Docker build and native SQLite runtime checks passed for both amd64 and arm64.

A final development-server check caught the viewer WebSocket rejecting Next.js's HMR connection, preventing initial client rendering with the upgraded framework. The viewer handler now owns only `/ws`, leaving framework upgrades to Next.js. Regression checks cover both server modes; native browser checks confirm map hydration, working viewer counts, local storm clocks, replay progress and live CSS updates without reloading.

Desktop Chrome at 1500 px and mobile Chrome emulation at 390 px covered the homepage, archive, daily totals, country pages, storm list, active and finished storm details, replay controls, records, navigation, and saved preferences. Final browser checks confirmed worker-backed archive paging forwards and backwards, saved Daily Totals selection, increasing country totals, replay playback, Dutch locale persistence and mobile navigation, with no page errors or local HTTP 5xx responses. Separate hydration checks passed in UTC, Amsterdam and New York, including a German browser locale.

The review did not observe an entire five-minute split/merge cycle on production, access production logs, or compare every stored record against an external source. Local deterministic tests cover the lifecycle findings. The magnitude of existing historical damage remains unknown.

Original reproduction scripts, compact result JSON, and screenshots are under `/tmp/lightning-website-audit-2026-09-09/` on this machine. Those scripts target the audited commit and may intentionally fail after the relevant defect is fixed.

The framework upgrade's combined validation report and temporary evidence are under `/tmp/lightning-framework-validation/` on this machine. Existing historical data was not blanket-rewritten; previously unrecorded strikes cannot be reconstructed without a retained source. Existing user changes in `app/globals.css` and `tsconfig.tsbuildinfo` were left out of these commits.
