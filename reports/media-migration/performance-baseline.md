# Performance baseline

Measured by `npm run simulate:v2` (`tests/perf/simulate-v2.ts`) on the host below. Raw data:
[`data/simulation-results.json`](data/simulation-results.json). **Read the caveats first.**

## Caveats (what these numbers are not)

* Images are **synthetic** (smooth noise + fine noise, JPEG quality 80–91). Real product photography compresses
  differently, so *size ratios below are not predictions* for V2's catalogue.
* Storage is the **local filesystem** and the database a local SQLite store: there is no network latency, no R2 request
  overhead, no MongoDB round-trip. Upload/verify/database timings are therefore lower bounds.
* One machine, one run per configuration; no repetition for variance. Single run, `concurrency=4`, 1 libvips thread per job.
* Host: Windows 11, Ryzen 7 7730U (8C/16T), 16.5 GB RAM, Node v24.15.0, sharp 0.35.5 / libvips 8.18.7.

## Workload

262 products → 791 distinct referenced source images (of 943 generated), avg source 1,579 KB (1.52 GB generated in total),
1,353 media values in 280 documents. 4 variants per image (400/800/1200/1600, WebP quality 80, effort 4, metadata stripped).

## Throughput and latency (`migrate`, full run, 350.3 s wall, concurrency 4)

| Phase | Count | Mean | Max | Total worker time | Notes |
|---|---|---|---|---|---|
| download (stream → temp file + SHA-256) | 769 | 11.4 ms | 68.8 ms | 8.8 s | local disk |
| **image transform + validate (per variant)** | 3,068 | **427 ms** | 1,066 ms | 1,310 s | dominant cost (~96% of worker time) |
| upload (PUT) | 3,068 | 6.8 ms | 72.3 ms | 20.8 s | local disk; real R2 will be network-bound |
| destination verification (re-read + SHA-256, per asset) | 767 | 20.0 ms | 111.7 ms | 15.4 s | `mode=full` |
| database reference update (per asset) | 787 | 5.0 ms | 29.6 ms | 4.0 s | 1,343 field updates; CAS |
| cache stage | 787 | 1.0 ms | 6.8 ms | 0.8 s | no-op provider |
| whole `process` stage per asset | 769 | 1,775 ms | 2,304 ms | 1,365 s | |

* **Assets/second:** 787 completed in 350 s ≈ **2.2 assets/s**; source bytes read ≈ 2.45 GB (downloads + verification
  re-reads), 1.22 GB written. At this rate the 1,252 files in V2's investigation would take roughly 9–10 minutes of
  transform time on comparable hardware, *plus real network time*. Worker CPU, not I/O, is the bottleneck here.
* **Retries:** 0 (nothing was injected). **Dry run** of a 20-asset sample: 10.1 s (sampled with the configured concurrency;
  it was 23.6 s when sampling was sequential — measured on the 60-product pilot before the change).
* Re-run of a completed migration: 0.09 s (no work). Re-migrating after a rollback: 24 s (variants reused and re-verified,
  not regenerated, vs 350 s initially).
* `inventory`: 1.5 s for 280 documents; `reconcile` 3.2 s; `verify` 9.4 s; `rollback` 5.6 s.

## Resource use

| Metric | Value | How measured |
|---|---|---|
| Peak process RSS during `migrate` | **413 MB** (includes the test harness and ~1 GB of Buffers it had just generated and released) | 10 ms sampling in the harness |
| Heap in use at end of run | 27 MB | `process.memoryUsage()` in the run summary |
| Peak temp-file budget in use | 15 MB (budget configured 512 MB; avg source 1.6 MB × 4 workers) | `ByteBudget.peak` recorded in the run summary |
| Streaming a 64 MB source | RSS growth < 48 MB asserted (tests); the file is never held in memory | `tests/concurrency` memory test |
| Streaming a 64 MB object through the HTTP handler | RSS growth < 48 MB asserted | `tests/integration/compat-handler` |

## Output size (synthetic data — do not extrapolate)

| Variant | Mean size | % of mean source (1,605 KB) |
|---|---|---|
| 400 px | 107.9 KB | 6.9% |
| 800 px | 298.4 KB | 19.0% |
| 1200 px | 493.9 KB | 31.5% |
| 1600 px | 654.7 KB | 41.8% |

Total stored per asset ≈ 1.55 MB of variants for a 1.6 MB original (the four variants together are about the size of one
original; storage cost roughly doubles, delivery cost per card drops by >90% at 400 px for these images). Real catalogue
numbers must be measured in Phase 0 of the migration plan; the V2 investigation reports a 340 KB median original.

## Sizing guidance (to be confirmed in staging)

* Transform time scales with pixels, not bytes; start at `concurrency = cores/2` with `threadsPerJob = 1`.
* `tempBudgetBytes` ≥ `concurrency × maxSourceBytes` avoids serialising large sources.
* R2 request budget per asset (S3 adapter, 4 variants): plan HEAD + source HEAD + source GET (3); per variant HEAD (exists?) +
  PUT + HEAD (visibility check) (12); verification HEAD + GET per variant (8) ⇒ about **23 requests/asset** (19 with
  `verification.mode=head`); use `migration.rateLimitPerSec` if throttled (throttling is retried with
  backoff and counted).

## Not measured

Real R2 latency/throughput, MongoDB update latency, AVIF encode cost, CPU on the production host, multi-run variance, memory
under 5,000+ asset journals (SQLite journal size for this run is small; no scale test beyond 791 assets).

## Journal scalability micro-benchmark (20,000 assets, one reference each)

`node dist-test/tests/perf/journal-bench.js --n 20000` → [`data/journal-bench.json`](data/journal-bench.json). SQLite WAL,
`synchronous=FULL`, same host.

| Operation | Measured |
|---|---|
| insert 20,000 assets + 20,000 references (one transaction) | 748 ms |
| 20,000 state transitions in one transaction | 1,028 ms |
| `claimNext` (atomic claim across connections), 2,000 calls | 0.79 ms per call |
| individual transition transactions (each fsynced), 2,000 | 0.80 ms each |
| `computeProgress` snapshot at 20,000 assets | 20.6 ms |
| journal file size | 14.6 MB |

Takeaway: journal overhead is negligible next to image transformation (≈1.8 s of worker time per asset in the simulation);
progress reporting can run every few seconds without scanning event history.
