# Test strategy

**Stack:** Node's built-in test runner (`node:test`) + `node:assert/strict`, `fast-check` for property tests, TypeScript
compiled to `dist-test/`. Rationale: matches V2's backend (also `node --test`), zero extra runtime dependencies, tests run
the *same compiled JavaScript* users run. No mocking framework: the engine depends only on interfaces, so tests inject
deterministic fakes (`src/testing/*`).

**Principles**
1. Failure is the default case: every external side effect and every state transition has a named failpoint; the crash
   matrix kills a run at each one and compares the recovered end state with an uncrashed run.
2. Assert on **real state** (database rows, object-store bytes, files on disk), never on what the engine says about itself —
   `src/testing/invariants.ts` re-derives I1/I5/I7/I9/I11/I15 from the stores after every scenario.
3. No wall-clock assertions where a barrier/hook can express the condition (`Barrier`, `Failpoints.on`, fake clocks). The only
   timing-adjacent tests are two RSS-growth bounds against 64 MB inputs (generous 48 MB margin) and CLI tests that *poll durable
   state* until a detached worker finishes.
4. No external network. Real-service contract suites are opt-in via environment variables and report **skipped** otherwise.
5. Simulated ≠ real: fakes are labelled (`FakeS3Client`, `FakeMongoClient`, `FakeCache`); `validation-results.md` records
   exactly what was exercised against what.

## Layout

| Dir | Contents |
|---|---|
| `tests/unit` | state machine (incl. property tests), IDs/keys, retry/backoff, redaction, URL/host policy, field patterns, MIME sniffing, config, CLI args, journal, processing (sharp), resolver, observability/reports/readiness, traceability |
| `tests/contract` | one suite run against memory / fs / S3-protocol storage (+ real S3 opt-in) and SQLite-docs / simulated-MongoDB database (+ real Mongo opt-in) |
| `tests/integration` | engine scenarios on fakes: migration, conflicts, rollback, reconcile, verify, cache, compat HTTP handler |
| `tests/fault-injection` | crash matrix (every failpoint × 2 hit counts), randomized crash/resume sequences, transient failures |
| `tests/concurrency` | bounded concurrency, byte budget, locks, shutdown, retry storms, poison pills, 30-asset stress, memory bound |
| `tests/security` | SSRF, traversal, injection, purge scope, malicious media, production guards, credential leakage |
| `tests/e2e` | the compiled CLI as a subprocess: validation, dry-run, gating, background, lock contention, stop, kill, rollback, secrets |
| `tests/perf` | `simulate-v2.ts` — not a test; produces `reports/media-migration/data/simulation-results.json` |
| V2 repo | `frontend/test/mediaUtils.test.ts`, `backend/test/media-mapping.test.ts` (integration side) |

## Fixtures

Generated programmatically from `src/testing/fixtures.ts` (pure functions of their arguments; no licences, no binaries
committed): JPEG/PNG/WebP, alpha, EXIF-rotated, EXIF-bearing, animated GIF/WebP, smooth gradients for perceptual checks,
truncated files, SVG/HTML/random bytes (wrong content), large dimensions (limit tests use low limits instead of
multi-gigapixel files), 64 MB random streams. Not covered: real camera files, CMYK, unusual ICC profiles.

## How to run

`npm test` (everything), `npm run test:fast`, `npm run test:fault`, `npm run test:e2e`, `npm run lint`,
`npm run audit:deps`, `npm run simulate:v2`. Coverage percentages are **not** reported (no coverage tool is configured);
coverage is argued through the traceability matrix instead.

## Known gaps (also in known-limitations.md)

Real R2 and MongoDB were unavailable; POSIX signal tests are written but skipped on this Windows host; literal
disk-full and OS-level OOM were not simulated; Express was not used (handler tested with `node:http`).
