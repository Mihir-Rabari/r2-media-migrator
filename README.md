# media-migrate

A reusable Node.js/TypeScript CLI that **optimises media and migrates database references safely**: it inventories the
media referenced from your database, generates deterministic WebP variants of S3-compatible (Cloudflare R2) originals,
verifies them by checksum, and only then rewrites the approved database fields — with a durable journal that makes every
run resumable, auditable and reversible.

It was built for V2 Enterprise (Express + MongoDB + R2) but nothing V2-specific is in `src/`: collections, fields, hosts and
layout are configuration.

> **Status:** engine, CLI, tests and documentation are implemented and verified locally (see
> [`reports/media-migration/validation-results.md`](reports/media-migration/validation-results.md)).
> **It has not been run against real R2 or a real MongoDB**, and no production migration has been (or can be, until the
> readiness gates pass) executed. See [`known-limitations.md`](reports/media-migration/known-limitations.md).

## What it guarantees (and how it is checked)

| Guarantee | Mechanism | Evidence |
|---|---|---|
| Database never points at an unverified asset (I1) | order of operations + state machine + `verify` scans the DB itself | `tests/integration`, `tests/fault-injection` |
| Dry runs mutate nothing (I2) | providers are wrapped read-only **inside the engine**, not just the CLI | engine + e2e byte-for-byte checks |
| Re-running is a no-op (I3) | deterministic IDs/keys, immutable variant keys, observe-then-act | `re-running a completed migration…` |
| External URLs are never rewritten (I4) | host allow-list + approved field map | `tests/security`, resolver property tests |
| Concurrent edits are never overwritten (I6, I13) | compare-and-set per field, `CONFLICT` state, rollback is CAS too | `tests/integration/conflicts-rollback` |
| A crash anywhere is recoverable | journal intent/outcome + reconciliation on restart | crash matrix: every failpoint × 2 + randomized |
| Progress/status is true | derived from durable state only; stale workers are reported as stale | `tests/unit/observability`, e2e |
| Secrets never leak (I12) | env-var *names* only in config, global redactor on every sink | `tests/security`, e2e |

## Install & build

```bash
npm ci
npm run build          # -> dist/
node dist/cli/main.js --help      # or: npx media-migrate --help after `npm link`
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite` for the journal). Dependencies: `sharp`, `@aws-sdk/client-s3`,
`mongodb`, `zod`.

## Quick start (local rehearsal, no cloud account needed)

```bash
cp examples/minimal.config.json media.config.json     # fs storage + sqlite document store
node dist/cli/main.js config validate --config media.config.json
node dist/cli/main.js plan     --config media.config.json
node dist/cli/main.js dry-run  --config media.config.json --limit 20     # review artifacts under .media-migrate/reports/<run>/
node dist/cli/main.js migrate  --config media.config.json --yes
node dist/cli/main.js verify   --config media.config.json
```

## Commands

| Command | Purpose | Mutates |
|---|---|---|
| `init` | write a starter config | local file |
| `config validate` | validate effective config, check secrets exist (never prints them) | – |
| `discover` | sample documents, suggest media fields missing from the field map | – |
| `inventory` / `plan` | scan DB, HEAD sources, summarise scope | journal only |
| `dry-run` | transform a sample into a review folder | local files only |
| `process` | generate + upload + verify variants (**no** DB change) | storage |
| `migrate` | `process` + update references + cache stage | storage, database |
| `status` / `logs` / `report` | durable progress, events, reports (`--run-id`) | – |
| `stop` / `resume` / `retry` | graceful stop (works on Windows), continue, re-arm failed/conflicting items | journal / as run |
| `verify` / `reconcile [--fix] [--deep]` | check/repair journal-vs-reality | `--fix` only |
| `rollback` | restore exact original values (CAS; never clobbers newer edits) | database |
| `readiness` | production checklist + attestations | local file |
| `export-mapping` | verified legacy→canonical mapping for the resolver | local file |

Common options: `--config --env --set k=v --dry-run --resume --run-id --concurrency --batch-size --limit --since --until
--json --verbose --quiet --yes --fail-on-warning --background`.
Background: `migrate --background --yes` returns when the worker is *running* (never when it is done); poll with
`status --run-id <id> --json`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success — the requested work is complete **and** postconditions passed |
| 1 | operational failure |
| 2 | validation failure (config/arguments), nothing was mutated |
| 3 | interrupted (state saved; resume) |
| 4 | incomplete (run finished but assets remain failed/conflicting/unfinished) |
| 5 | verification incomplete or failed |
| 6 | rollback conflicts/failure |
| 7 | journal locked by another run |
| 8 | blocked by a safety gate (no `--yes`, production not authorised, readiness not met) |

## Architecture (one paragraph)

`domain` (types, state machine, IDs) ← `core` (provider **interfaces**, failpoints, dry-run guards, retry, limits) ←
`migration` (engine, rollback, reconcile, verify) which sees only interfaces; adapters live in `storage` (S3/R2, fs,
memory), `database` (MongoDB, SQLite docs), `processing` (sharp), `cache` (Cloudflare), `journal` (SQLite). `compatibility`
holds the URL resolver and a framework-neutral HTTP handler for legacy URLs that reach your app. Details and rejected
alternatives: [`architecture.md`](reports/media-migration/architecture.md).

## Documentation

* Runbook: [`docs/operations.md`](docs/operations.md)
* Reports: [`reports/media-migration/`](reports/media-migration/) — architecture, reference map, transformation spec,
  configuration reference, state machine, recovery matrix, test strategy + traceability, migration & rollback plans,
  validation results, performance baseline, known limitations.

## Tests

```bash
npm test            # build + full suite (unit, contract, integration, fault-injection, concurrency, security, e2e)
npm run test:fast   # unit + contract + security
npm run lint        # strict tsc + architecture-boundary / hygiene checks
npm run simulate:v2 # V2-shaped end-to-end simulation (writes measurements)
npm run audit:deps
```

Opt-in real-service contract tests: set `MEDIA_MIGRATE_TEST_S3_BUCKET/_ENDPOINT/_KEY/_SECRET` and/or
`MEDIA_MIGRATE_TEST_MONGO_URI`.

## License

MIT
