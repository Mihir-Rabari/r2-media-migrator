# Operations runbook

All commands take `--config <file>`; add `--json` for machine-readable output. State lives in `<journalDir>` (default
`.media-migrate/`): `journal.sqlite` (+ WAL), `backups/`, `logs/`, `reports/`, `readiness.json`, `mapping.jsonl`.
**Back up the journal directory with the same care as the database**; it holds the exact previous value of every field the
tool changed.

## 0. Prerequisites (once)

1. Credentials as environment variables (names are in the config): R2 key pair, `MONGODB_URI`, optional Cloudflare token.
   Least privilege: R2 token with **read** on source prefixes and **write only under `media/`** (no delete); a MongoDB
   user with `find`+`update` on the approved collections only.
2. `media-migrate config validate --config media.config.json --fail-on-warning` → exit 0.
3. `media-migrate discover --config media.config.json` → every media-looking field is either mapped or consciously excluded.

## 1. Dry run (safe at any time, including production)

```bash
media-migrate plan    --config media.config.json            # scope: assets, references, bytes, skipped, duplicates, external hosts
media-migrate dry-run --config media.config.json --limit 50  # transforms a sample; NO storage/database/cache mutation
```
Open `<reportDir>/<runId>/review.html` and `contact-sheet.png`: compare sources with 400/800/1200/1600 variants (banding,
colour, orientation, transparency, size). Record approval: `readiness --attest samples`.

## 2. Starting a run

```bash
media-migrate process --config media.config.json --limit 50 --yes     # stage + verify a sample in the real bucket (no DB change)
media-migrate migrate --config media.config.json --yes                # the full migration (interactive terminal)
media-migrate migrate --config media.config.json --yes --background   # detached worker; returns when it is RUNNING
```
Non-interactive runs require `--yes`. In `environment: "production"` you additionally need
`safety.allowProductionMutations: true` and a passing `readiness` checklist (for `migrate`; `process` only adds new
immutable objects and needs the first two). `--yes` never bypasses config validation, readiness or any invariant.

## 3. Monitoring a (background) run

```bash
media-migrate status --config … --run-id <id>        # phase, counts, bytes, throughput, ETA (only when meaningful), last checkpoint, blocking error
media-migrate logs   --config … --run-id <id> --tail 100 [--level warn] [--asset <assetId>]
tail -f .media-migrate/logs/<runId>.worker.log       # raw worker output (background runs)
```
`status` reports **`INTERRUPTED (stale)`** when the journal says RUNNING but the worker is gone (dead PID or expired
heartbeat). It never shows a dead worker as running. Percent/ETA show `unknown`/`n/a` until the inventory is complete.

Stop gracefully (finishes the current stage, saves state, releases the lock → status `INTERRUPTED`, exit 3):
`media-migrate stop --config … --run-id <id>` (works on Windows; on POSIX Ctrl-C / SIGTERM does the same).

## 4. Recovering after a crash / reboot

1. `status --run-id <id>` → `INTERRUPTED (stale)`.
2. `media-migrate resume --config … --run-id <id> --yes` (or `migrate … --resume --run-id <id>`).
   The stale lock is taken over atomically, claims are cleared, temp files are wiped, and each item continues from its
   durable state; a reference left in `UPDATING` is resolved by *looking at the document*.
3. If the journal itself is damaged (`JOURNAL_UNREADABLE`): nothing was mutated. Restore the newest
   `<journalDir>/backups/journal-N.sqlite` over `journal.sqlite` and run `reconcile` (read-only) before resuming.

## 5. Investigating failures

```bash
media-migrate report --config … --run-id <id>      # report.json/.md, assets.jsonl, errors.jsonl, mapping.jsonl
media-migrate logs   --config … --run-id <id> --level error --tail 200
```
Exit code 4 means "finished but not complete". The report's *Failed / blocked assets* table gives per-asset state and error:

| State | Typical cause | Action |
|---|---|---|
| `FAILED` | corrupt image, retry budget exhausted, cache failure | fix cause; `retry --yes` |
| `SOURCE_MISSING` | original deleted | restore it; `retry --yes` (references were never touched) |
| `CONFLICT` | a document was edited mid-run, source bytes changed, a foreign object sits on a variant key | inspect `logs --asset`; fix data; `retry --yes`. For changed sources/profiles bump `destination.namespaceVersion` |
| `SKIPPED` | policy (video, SVG, animated, non-image content) | nothing to do, or change policy and `retry` |

## 6. Retrying

`media-migrate retry --config … --yes [--asset <id>] [--state FAILED --state CONFLICT]` re-arms the selected assets
(attempt counters reset, conflicting references re-observed) and runs them as a partial-scope migrate run.

## 7. Reconciling

`media-migrate reconcile --config …` (read-only) compares journal ↔ object store ↔ database: missing/corrupt destination
objects, originals missing, references reverted or edited outside the tool, orphaned objects under `media/v1/`. Exit 5 when
anything is unexplained. `--fix` applies only conservative repairs (adopt a reference whose write landed; re-queue an
asset whose objects vanished). **Orphans are recorded, never deleted** — decide deletion by hand after review.
`--deep` re-hashes every destination object. `verify` additionally scans the database and fails on any canonical URL that
has no verified destination.

## 8. Rolling back

```bash
media-migrate rollback --config … --dry-run                  # plan
media-migrate rollback --config … --yes [--from-run <id>] [--asset <id>]
```
Restores the exact previous value of each reference by compare-and-set on the value the tool wrote. A field edited since is
reported as a conflict and **left alone** (exit 6). Destination objects and originals are never deleted. Re-running
`migrate` later migrates again. See `reports/media-migration/rollback-plan.md`.

## 9. Credential rotation

1. Create the new key; export it under the **same variable names** (or change the `*Env` names in the config).
2. `config validate` → exit 0. 3. Revoke the old key. A running worker keeps its connection until it exits; restart it
(`stop` → `resume`). Secrets never touch the journal, logs or reports (verified by tests).

## 10. Testing against staging

Use a staging config (`environment: "staging"`, staging bucket/DB, distinct `journalDir`), or the filesystem/SQLite
providers for a fully local rehearsal. `npm run simulate:v2` runs the whole workflow on a V2-shaped synthetic dataset.
Real-service contract tests: `MEDIA_MIGRATE_TEST_S3_*`, `MEDIA_MIGRATE_TEST_MONGO_URI`.

## 11. Legacy URL compatibility (optional)

* Frontend/API: canonical URLs are deterministic (`<base>/media/v1/<assetId>/<width>.webp`); no lookups needed.
* Requests that reach your **application** under a prefix (e.g. `/legacy-media/products/x.jpg`):
  `createLegacyMediaHandler({ resolver: mappingResolver.current, routePrefixes: ['/legacy-media'], mode: 'redirect' })`
  (works as Express middleware: `app.use(handler)`); regenerate the mapping with `export-mapping`.
* Traffic sent straight to `cdn.<domain>` never reaches Express. Redirecting those would need a Cloudflare rule/Worker —
  **not applied by this tool**; legacy objects remain in place, so old URLs keep working.
