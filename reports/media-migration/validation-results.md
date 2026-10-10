# Validation results

Everything below was **executed in this session on one machine**; nothing is estimated. Where a check could not run, it is
listed as NOT RUN with the reason. Statuses: PASS / FAIL / BLOCKED / NOT RUN.

* Host: Windows 11, AMD Ryzen 7 7730U (16 threads), 16.5 GB RAM, Node v24.15.0, sharp 0.35.5 (libvips 8.18.7)
* Tool commit under test: `25b1076` (+ documentation-only commits)
* Raw outputs: simulation → [`data/simulation-results.json`](data/simulation-results.json)

## 1. Automated test suites (`npm test`, then each directory individually)

| Suite | Tests | Pass | Fail | Skipped | Wall time | Status |
|---|---|---|---|---|---|---|
| `tests/unit` (state machine + property tests, IDs, retry, redaction, URL/host policy, field patterns, MIME, config, CLI args, journal, processing, resolver, observability, traceability) | 82 | 82 | 0 | 0 | 5.5 s | PASS |
| `tests/contract` (storage: memory / fs / S3-protocol; database: SQLite-docs / simulated MongoDB driver) | 56 | 55 | 0 | 1 | 0.6 s | PASS (1 skipped = real MongoDB opt-in, **NOT RUN**) |
| `tests/integration` (engine scenarios, conflicts, rollback, reconcile, verify, cache, compat HTTP handler) | 37 | 37 | 0 | 0 | 10.3 s | PASS |
| `tests/fault-injection` (crash matrix, randomized crash/resume, transient errors) | 55 | 55 | 0 | 0 | 43.4 s | PASS |
| `tests/concurrency` (bounds, barrier, byte budget, locks, shutdown, retry storm, poison pill, stress, memory) | 14 | 14 | 0 | 0 | 7.6 s | PASS |
| `tests/security` | 11 | 11 | 0 | 0 | 1.8 s | PASS |
| `tests/e2e` (compiled CLI as subprocess) | 15 | 14 | 0 | 1 | 37.6 s | PASS (1 skipped = POSIX SIGINT/SIGTERM on a Windows host, **NOT RUN**) |
| **Total** (`npm test`, serial) | **270** | **268** | **0** | **2** | **111.7 s** | **PASS** |

The first full run (before the final hardening) had **1 failure** — the 64 MB streaming test for the HTTP handler measured
RSS growth of 68.9 MB because the *test's own in-memory store* emitted the object as a single 64 MB chunk. The test fixture
was corrected to emit 64 KB chunks like a network store; the handler was not changed. Earlier in development the e2e suite
exposed a **real bug** (resuming a run with a different `--concurrency` was rejected as "config changed"); the config
fingerprint now covers only output-affecting settings. Several other defects were found by tests and fixed during
development (CJS config loading via `import()`, backoff formula, `--limit` race between concurrent workers, ambiguous
`//key` URLs, redaction of `secretAccessKey:` forms, an ID-aliasing edge in `assetIdFor`, over-permissive
`RECONCILE_REQUIRED` transitions) — each now has a regression test.

Per-suite outputs are reproducible with `node --test dist-test/tests/<dir>/*.test.js`.

### Requirement/invariant coverage
`test-traceability-matrix.md` maps invariants I1–I15 and every §13 category to tests; `tests/unit/traceability.test.ts`
(PASS) fails the build if any reference is stale. Line/branch coverage percentages: **NOT MEASURED** (no coverage tool).

## 2. Static checks

| Check | Result |
|---|---|
| `npm run lint` = `tsc --noEmit` (strict, `src` + `tests`) + `scripts/check-repo.js` (architecture boundary: no adapter/SDK imports in `domain/core/migration/inventory`; no shell APIs; no `console.*` in `src`) | PASS (53 source files) |
| `npm run build` | PASS |
| ESLint | NOT RUN (not installed; see known limitations) |
| `npm audit --omit=dev` | **initially FAIL** — 1 high-severity advisory in `sharp ≤ 0.35.5-rc.1` (bundled libvips/libheif/librsvg). Upgraded to `sharp 0.35.5`; now `found 0 vulnerabilities` → PASS. All 270 tests re-run on the upgraded library |
| CI workflow (`.github/workflows/ci.yml`, ubuntu+windows × Node 22/24, plus a Mongo job) | defined; **NOT RUN** |

## 3. V2 Enterprise side (separate repo, branch `feature/media-canonical-urls`, committed locally, **not pushed**)

| Check | Baseline (before) | After |
|---|---|---|
| Backend `npm test` | 8 pass / 0 fail | 9 pass / 0 fail (+1 new `media-mapping.test.ts`) — PASS |
| Backend `tsc --noEmit` | clean | clean — PASS |
| Frontend `npm run test:media` (new) | n/a | 6 pass / 0 fail — PASS |
| Frontend `vite build` (to a temp dir) | succeeds (per investigation report) | succeeds (19.5 s) — PASS |
| Frontend type-check for the touched files | – | no errors reported for `mediaUtils.ts`, `ProductCard.tsx`, `MediaManagerModal.tsx` (the repo has pre-existing TS noise elsewhere) — PASS for touched files |
| Browser/visual verification of the storefront | – | **NOT RUN** (no running V2 stack, no canonical data) |

## 4. End-to-end simulation (V2-shaped, real CLI code path, filesystem + SQLite doc store)

262 products / 943 synthetic JPEGs (avg 1,579 KB, 1,200–3,024 px wide) / 12% of product URLs on a `pub-…r2.dev` host /
shared images / hero MP4 / third-party seed URLs / one truncated JPEG / one HTML-as-JPG / one missing file / one
byte-identical duplicate. Config derived from `examples/v2-enterprise.config.json`. Steps were run through `runCli`.

| Step | Exit | Wall | Result |
|---|---|---|---|
| `config validate` | 0 | 0.01 s | PASS |
| `inventory` | 0 | 1.5 s | 280 docs, 1,353 values seen: 1,348 legacy; **external hosts counted, not touched** (pexels 2, imagekit 1, own-origin 1, unsplash 1) |
| `plan` | 0 | 0.15 s | read-only summary |
| `dry-run --limit 20` | 0 | 10.1 s | **database and storage tree byte-identical before/after** → PASS (I2) |
| `process --limit 20 --yes` | 0 | 9.7 s | `COMPLETE (PARTIAL SCOPE: not a full migration)` |
| `migrate --yes` | **4** | 350.3 s | 787 COMPLETE, 2 SKIPPED (video, HTML-as-image), 1 FAILED (truncated JPEG), 1 SOURCE_MISSING → **INCOMPLETE, not success** (correct) |
| `verify` | **5** | 9.4 s | not verified because the migration is incomplete (correct; I10) |
| `migrate` again | 4 | 0.09 s | **no database or storage change** → PASS (I3) |
| `reconcile` | 0 | 3.2 s | consistent |
| `rollback --yes` | 0 | 5.6 s | **database snapshot equals the original byte-for-byte** → PASS (I13 / exact restoration) |
| `migrate` after rollback | 4 | 24.2 s | re-migrates (variants reused, not regenerated); same 2 unfinished assets |
| `verify` after re-migrate | 5 | 7.8 s | same reason |

Journal integrity check after the whole sequence: OK. The numbers describe the *tool on synthetic data*, not production.

## 5. Crash-recovery evidence

* `tests/fault-injection/crash-matrix.test.ts`: 25 failpoints × {1st, 3rd hit} = **50 crash cases, all PASS**; each asserts
  not-complete-at-crash, invariants at the crash instant, recovery to a database + object store **identical to an uncrashed
  run**, a no-op second resume, a recorded stale-lock takeover.
* 5 seeded randomized sequences of 12 crash/resume cycles, a 30-asset / 6-worker randomized stress run, a poison-pill test
  (crash-looping asset is quarantined after its attempt budget), transient-error injection at 5 side effects (retried and
  counted), persistent errors (bounded then terminal). All PASS.
* CLI level: `process-kill crash (hard exit mid-run)` — `exit 86` from `MEDIA_MIGRATE_FAILPOINTS=upload:after=exit@3`;
  `status` reports `INTERRUPTED (stale)`; `verify` exits 5; `resume` completes; `verify` exits 0. PASS.

## 6. Rollback evidence
Exact restoration (unit-level snapshot equality and simulation); conflict preservation (user edit untouched, exit 6);
confirmation required (exit 8); dry-run read-only; rollback of a half-finished migration; re-migration after rollback. PASS.
Not tested against a real MongoDB.

## 7. Background execution / progress evidence
`e2e: background run survives the launching process…` (launch returns `started:true` with the note *"NOT completion"*;
status immediately after launch ≠ COMPLETE; polling durable state until COMPLETE; log file exists; report works),
`e2e: lock contention (exit 7)…` (second start refused, `stop` → INTERRUPTED → `resume` → all complete),
`e2e: foreground run interrupted via stop` (exit 3). Progress values are derived from the journal and are identical after a
journal re-open (`progress is derived from durable state`). PASS.

## 8. Real service vs mock

| Dependency | Exercised against | Status |
|---|---|---|
| Cloudflare R2 / S3 | in-memory, filesystem, S3-protocol fake | real R2: **NOT RUN** (no credentials); opt-in suite exists |
| MongoDB | SQLite document store, driver simulator | real MongoDB: **NOT RUN** (no server; Docker daemon off); transactions on a real replica set: **NOT RUN** |
| Cloudflare purge / live CDN | mocked `fetch` | **NOT RUN** against the API or `cdn.v2enterprise.in` |
| sharp / libvips | real library on generated fixtures | **real** |
| SQLite journal | real `node:sqlite` on disk, multiple connections/processes | **real** |
| Process model (detached worker, locks, kill) | real child processes via the compiled CLI | **real** (Windows) |
| V2 data | synthetic | **NOT RUN** against real data |

## 9. Production-readiness status

**BLOCKED.** Automatic gates cannot pass without V2 data (inventory, dry run, destination sample), and the attestation
gates (sample review, mapping review, compatibility test, staging rollback test, release tests, operator authorisation)
are human steps that have not happened. See `migration-plan.md`. The tool will refuse a production `migrate` until they do.
