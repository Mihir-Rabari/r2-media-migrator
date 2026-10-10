# Migration plan (V2 Enterprise)

**Production execution is blocked.** Nothing in this repository has been run against V2's real R2 bucket or MongoDB, and
the CLI will refuse `migrate` in `environment: production` until every gate in the readiness checklist is satisfied and an
operator has explicitly authorised the run. This plan is the procedure to get there.

## Readiness checklist (enforced by `media-migrate readiness`; `migrate` in production re-evaluates it)

| # | Gate | Kind | How it becomes PASS | Status today |
|---|---|---|---|---|
| 1 | Configuration validates | automatic | `config validate --fail-on-warning` | PASS for the example config (placeholders: account id, `pub-…r2.dev` host, `database` if not in the URI) |
| 2 | Inventory complete enough to establish scope | automatic | an unscoped `inventory` run for the current config fingerprint | **BLOCKED** — no access to V2 data |
| 3 | Dry run completed with error-free samples | automatic | `dry-run --limit 50` | **BLOCKED** (simulated only) |
| 4 | Destination uploads + checksum verification for a sample | automatic | `process --limit 50 --yes` (adds immutable objects only; no DB change) | **BLOCKED** |
| 5 | Journal integrity (incl. I1) | automatic | built in | — |
| 6 | No failed/conflicting/reconcile-required assets | automatic | fix + `retry` | — |
| 7 | Samples visually reviewed and approved | attestation | review `review.html`; `readiness --attest samples` | **BLOCKED** |
| 8 | Database field mappings reviewed | attestation | review `media-reference-map.md` + `discover`; `--attest mapping` | **BLOCKED** |
| 9 | Compatibility behaviour tested | attestation | frontend on a staging build + admin thumbnails; `--attest compat` | **BLOCKED** |
| 10 | Rollback + recovery tested on staging | attestation | `rollback --dry-run`, then a real rollback on staging; `--attest rollback` | **BLOCKED** (tested only on simulated stores) |
| 11 | Mandatory automated tests pass | attestation | `npm test` green on the release commit; `--attest tests --tested-commit <sha>` | see `validation-results.md` |
| 12 | Operator authorises the production run | attestation | `readiness --attest authorize --authorized-by "<name>"` | **BLOCKED** (by design) |

Attestations are bound to the configuration fingerprint; any semantic config change invalidates them.

## Phases

### Phase 0 — Staging rehearsal (no production access)
1. Restore a production MongoDB snapshot and copy a representative slice of the bucket into **staging** resources.
2. Fill the V2 example: R2 `ACCOUNT_ID`, the exact `pub-….r2.dev` host, staging bucket/endpoint; `environment: staging`.
3. `config validate`, `discover`, `plan`, `dry-run --limit 100`, visual review.
4. `migrate --yes` on staging; `verify`; `reconcile`; run the V2 frontend against the staging API; check admin library
   thumbnails (`MEDIA_MAPPING_FILE` set to the exported mapping).
5. `rollback --dry-run`, `rollback --yes`, compare database to the snapshot (exact), `migrate` again.
6. Crash drill: `kill -9` the worker mid-run → `status` shows stale → `resume`.
7. Record durations and extrapolate (see `performance-baseline.md`); size `concurrency` against R2 limits.

### Phase 1 — Production read-only
`plan` and `dry-run --limit 50` against production credentials with **read-only** keys. Confirms real scope and host
mappings (`pub-…` URLs resolve to the same keys as the CDN host, collection names, no extra media fields).

### Phase 2 — Production stage (additive, reversible)
Allow production mutation (`safety.allowProductionMutations: true`, `--yes`), then:
`process --limit 50 --yes` then `process --yes`. This only **adds** objects under `media/v1/`; no database record changes
and no existing object is touched, so this phase can be abandoned at any point by ignoring the namespace.

### Phase 3 — Reference switch
Complete the readiness attestations. Take a MongoDB backup (the journal also stores every previous value). Then
`migrate --yes --background`; monitor with `status`; `verify`; spot-check the site. Re-run `migrate` after any new upload
(idempotent) — **new uploads still create legacy-style URLs** until the upload path is changed (follow-up, see limitations).

### Phase 4 — Soak and cleanup (separate decision)
Originals are kept (`originals.retention: keep`). Deleting originals or orphans is **not implemented** and must be a
separate, reviewed change after the soak period.

## Rollout order of the application changes
1. Deploy the V2 frontend helper change (`feature/media-canonical-urls`): it is a no-op for legacy URLs.
2. Run the migration. 3. Deploy backend with `MEDIA_MAPPING_FILE` for admin thumbnails (optional, independent).

## Go / no-go criteria for Phase 3
All gates PASS; staging rehearsal produced an exact rollback; `verify` PASS on staging; visual approval recorded; backup
taken and restorable; on-call operator named; rollback decision owner named.
