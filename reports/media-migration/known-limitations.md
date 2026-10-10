# Known limitations and coverage gaps

Status words: **NOT RUN** = code exists, could not be executed here; **NOT IMPLEMENTED** = deliberately absent.

## Integration with real services

| Area | State | Substitute used | Residual risk |
|---|---|---|---|
| Cloudflare R2 / S3 | **NOT RUN** (no credentials) | `FakeS3Client` (S3 protocol: HEAD/GET/PUT/DELETE/LIST, Range, `If-None-Match`, metadata, 404/412/416/403/503 errors) + the shared storage contract on memory and fs providers. The opt-in suite (`MEDIA_MIGRATE_TEST_S3_*`) runs the **same** contract against a real bucket | `If-None-Match: *` on `PutObject` and user-metadata round-trips are assumed to behave as documented for R2; request timeouts/`maxAttempts` handler options are untested against the live SDK |
| MongoDB | **NOT RUN** (no `mongod`; Docker daemon not running) | `SqliteDocDatabase` and a driver simulator (`FakeMongoClient`) through one shared contract. A real-Mongo run is opt-in (`MEDIA_MIGRATE_TEST_MONGO_URI`) and wired in CI (`mongo-integration` job, single-node, so the *transaction* assertions need a replica set and are not exercised there either) | positional-array filters (`photos.2`), `_id` serialisation, topology detection (`hello`), `withTransaction` abort semantics were exercised only against the simulator. **Transaction mode has never run against a real replica set** |
| Cloudflare cache API | tested against a mocked `fetch` only | `CloudflareCache` request-shape tests | token scopes, rate limits and response shapes unverified; purge acceptance is not proof of edge/browser invalidation |
| Live CDN behaviour (`cdn.v2enterprise.in`) | not touched | – | nothing about the real network path was re-verified; facts about it are *quoted* from V2's investigation report |
| V2 production data | not accessed | synthetic dataset modelled on the investigation's numbers | collection names are Mongoose-pluralisation guesses to confirm with `discover`; host mapping for `pub-…r2.dev` unverified |

## Behaviour gaps

* **Video is not optimised** (skipped, references never rewritten). Hero/promotional MP4s stay as they are.
* **New uploads** still go through V2's old upload path and produce legacy-style URLs. Re-run `migrate` (idempotent) after
  uploads, or later move processing into the upload path. Until then migrated + un-migrated URLs coexist (the frontend
  helper handles both).
* **Orders' `productPhoto`** and **`Media.url`** are intentionally not migrated (see the reference map).
* **No deletion** of originals, orphans or old variants. Retention beyond `keep` is NOT IMPLEMENTED by design.
* **Permanent conflicts** (a field a human changed to something unrelated) have no "abandon" operation; they keep the run
  `INCOMPLETE` until the data is fixed or rolled back.
* **Namespace/profile changes** require bumping `destination.namespaceVersion`; variants are never overwritten. A source
  whose bytes changed after migration is flagged `CONFLICT`, not auto-migrated again.
* **AVIF** is supported by the code path and capability-checked, but was not benchmarked; WebP is the default.
* **Single host**: the SQLite journal and the lock are local to one machine (documented trade-off vs. a DB-backed worker).
  Two machines pointed at the same journal over a network share are not supported.
* **`node:sqlite`** is a recent Node built-in (Node ≥ 22.13; Node documents it as an actively developed API). Journal
  schema is versioned (`meta.schema_version`) and backed up with `VACUUM INTO`.
* **Compat HTTP handler** is framework-neutral and tested with `node:http`, **not** with Express itself (its middleware
  signature is the same). It is not mounted in V2's app: requests to `cdn.v2enterprise.in` never reach Express, and
  changing Cloudflare routing is outside this tool and unconfigured.
* **Frontend**: only `ProductCard` (srcset) and the admin media grid were changed; other call sites benefit from the
  helper through `getOptimizedImageUrl` but were not visually re-verified. The product-detail page was not modified
  (`getHighResImageUrl` is available). No browser/visual regression test exists in V2.
* **ESLint**: not installed (no new dev dependency was added just for style). `npm run lint` = strict `tsc` (src + tests) +
  `scripts/check-repo.js` (architecture boundary, no shell APIs, no `console.*`).
* **Coverage percentage** is not measured (no coverage tool configured); the traceability matrix is the coverage argument.

## Test-environment gaps

* **POSIX SIGINT/SIGTERM** e2e test is written but **skipped on this Windows host** (child processes cannot receive
  catchable signals on Windows). Graceful shutdown is covered cross-platform via `stop` (journal flag), the in-process
  `ShutdownController` tests, and the CI workflow runs the test on Linux (not yet executed).
* **Literal disk-full / OOM-kill** were not simulated; bounds are proven through the byte-budget semaphore and write errors
  are covered by the generic transient-failure path.
* **Performance numbers** come from synthetic noise-based "photos" on a local filesystem (no network latency, atypical
  compressibility); see `performance-baseline.md` for what they do and do not predict.
* **Windows + Linux CI matrix** is defined in `.github/workflows/ci.yml` but has not run (nothing pushed triggers it
  with results available to this session).

## Security notes

* Dependency review: `npm audit --omit=dev` found a **high-severity advisory in `sharp ≤ 0.35.5-rc.1`** (bundled
  libvips/libheif/librsvg). Fixed by upgrading to `sharp 0.35.5` (libvips 8.18.7); the audit is now clean. Re-run
  `npm run audit:deps` regularly — this tool decodes untrusted bytes.
* Decoding untrusted images is inherently risky; mitigations in place: content sniffing, allow-listed input formats
  (SVG/HEIF excluded by default), pixel and byte limits, strict decode, no shell, bounded concurrency/temp space. Running the
  tool in a low-privilege container with no network path to anything except R2/MongoDB is recommended.
* The tool trusts its operator-supplied configuration; the `readiness` attestations are an auditable human checkpoint,
  not an authentication mechanism.
