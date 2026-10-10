# Recovery matrix

Principle: **recovery observes reality, it does not replay intent.** Every stage is idempotent, intent is journaled before
an irreversible step, outcome after, and a restarted run re-derives what is true from storage and the database.

`tests/fault-injection/crash-matrix.test.ts` runs, for **every failpoint below at its 1st and 3rd hit**
(`50` crash cases + `5` randomized multi-crash seeds + transient-error cases): kill the run → assert the run is not
reported complete → assert safety invariants hold *at the crash instant* → restart as a new "process" and `--resume` →
assert the **final database and object-store state is byte-identical to an uncrashed run** → resume again (no-op) →
assert an auditable summary exists and the stale-lock takeover was recorded. Results: `validation-results.md`.

## Per failpoint

| Failpoint (where the process dies) | Durable state at that instant | Real-world side effects possible | Recovery on resume |
|---|---|---|---|
| `download:before` / `:after` | asset `PROCESSING` | none / temp file on disk | claimed asset in `PROCESSING` counts one attempt; temp dir wiped at run start (exclusive lock); re-download |
| `process:after` | `PROCESSING`; (variant rows from earlier variants may exist, `verified=0`) | local temp variant only | regenerate; identical output (deterministic) |
| `upload:before` | variant row `verified=0` (intent) | none for this variant | head → absent → put |
| `upload:after` | variant row `verified=0` | object exists at destination | head shows object with matching `sha256`+size → upload skipped (idempotent) |
| `transition:before:ASSETS_WRITTEN` | still `PROCESSING` | all variants uploaded | stage re-run is a no-op (reuse), then transition |
| `transition:after:ASSETS_WRITTEN` | `ASSETS_WRITTEN` | same | verify stage |
| `verify:before` / `verify:after` | `ASSETS_WRITTEN`; variants `verified` 0 or 1 | none | re-verify (re-read + SHA-256); corrupt own objects are deleted and regenerated |
| `transition:*:DESTINATION_VERIFIED` | `ASSETS_WRITTEN` or `DESTINATION_VERIFIED` | none | continue |
| `db:before-intent` | refs `PENDING` | none | observe document, then write |
| `db:after-intent` | refs `UPDATING` (intent) | none | observe: value == original → compare-and-set again |
| `db:before-write` | refs `UPDATING` | none | same as above |
| **`db:after-write`** | refs `UPDATING` | **database already holds the new URL** | observe: value == new → adopt as `UPDATED` without writing (`reconcile` reports it as `reference-adoptable`) |
| `transition:*:REFERENCES_UPDATED` | refs `UPDATED`, asset `DESTINATION_VERIFIED` or `REFERENCES_UPDATED` | database updated | references stage finds nothing pending → advance |
| `cache:before` / `cache:after` | `REFERENCES_UPDATED`, cache op maybe recorded | purge request may have been accepted | repeat (purge/verify are idempotent per URL) |
| `transition:*:CACHE_HANDLED` / `:COMPLETE` | `CACHE_HANDLED` / `COMPLETE` | none | postconditions re-asserted before `COMPLETE` |

## Other failure classes

| Failure | Behaviour | Test |
|---|---|---|
| Transient provider error (reset, 429/5xx, SlowDown) | bounded exponential backoff + jitter; each retry counted in the journal | `transient failures: one injected error per external side effect…` |
| Persistent provider failure | retry budget exhausted → item `FAILED` (terminal); run `INCOMPLETE`; **no further calls on resume** | `retry storm…`, `transient failures: a persistent error…` |
| Too many failures | scheduling stops; run `FAILED` | `failure threshold…` |
| Crash loop on one asset (poison pill) | every recovery of a `PROCESSING` asset costs one attempt → `FAILED` after `maxItemAttempts` | `poison pill…` |
| Corrupt/truncated/non-image source | `FAILED` / `SKIPPED`; references untouched | `missing source, video, svg, html-as-jpg and corrupt files…`, security tests |
| Source object missing | `SOURCE_MISSING`; references untouched | same |
| Source changed between attempts | `CONFLICT (source changed)` — never silently re-migrated | `source content that changes between attempts…` |
| Destination key occupied by someone else | `CONFLICT`; never overwritten | `a foreign object occupying a destination key…` |
| Destination object corrupted after upload | detected by full verification, removed (only if this tool wrote it), regenerated | `corrupted destination bytes…` |
| Concurrent edit of a media field | compare-and-set fails → `CONFLICT`; user's value preserved | `conflict: …` tests |
| Database unavailable mid-batch | transient → retried; exhausted → `FAILED`; `UPDATING` rows are resolved by observation on resume | crash matrix (`db:*`) + `retry storm` |
| Journal file unreadable/corrupt | `JOURNAL_UNREADABLE`, nothing mutated; periodic consistent backups in `<journalDir>/backups/` (`VACUUM INTO`) | `journal: corrupt file…`, `backupTo…` |
| Process killed (SIGKILL, power loss) | stale lock detected (dead PID / expired heartbeat), atomically taken over; old run marked `INTERRUPTED`; `status` shows `INTERRUPTED (stale)` | `e2e: process-kill crash…` |
| SIGINT / SIGTERM (POSIX) | stop scheduling, finish current stage, persist, release lock, exit 3 | `e2e: SIGINT / SIGTERM…` (POSIX only — see known limitations) |
| `stop` command / Windows | same graceful path via a journal flag polled by the worker | `shutdown: stop request…`, `e2e: foreground run interrupted via stop` |
| Hung download at shutdown | abort signal after the grace period; asset left `PROCESSING` with `lastError=interrupted` (not counted as a failure) | `shutdown: aborting an in-flight (stalled) download…` |
| Two processes start | second gets exit 7 (`LOCKED`) without touching anything | `lock: a second engine cannot start…`, `e2e: lock contention` |
| Cache purge failure | asset not `COMPLETE`; failure recorded per URL; run `INCOMPLETE`; `retry`/resume re-attempts | `cache: a failed purge is visible…` |
| Rollback while users edited fields | those references become `ROLLBACK_CONFLICT`, are **not** overwritten; exit 6 | `rollback: never overwrites…` |
| Manual intervention (object deleted, reference reverted) | found by `reconcile`; `--fix` re-queues / adopts; orphans recorded, never deleted | `reconcile: …` tests |
| Disk exhaustion | bounded by `tempBudgetBytes` (byte-weighted semaphore) and per-asset temp cleanup; **a literally full disk was not simulated** (the failure would surface as a write error → transient retry → `FAILED`) | `concurrency: temp-byte budget…` |

## What is intentionally *not* recoverable by the tool

* Objects uploaded by a crashed run for assets that are later rolled back remain in the bucket (recorded as orphans).
* A database write acknowledged by MongoDB but lost to a primary failover before replication is outside the tool's
  control; `verify`/`reconcile` will report such a reference as pending/diverged.
