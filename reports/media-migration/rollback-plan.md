# Rollback plan

## What the tool changes (and therefore what rollback must undo)

| Change | Reversible by `rollback`? |
|---|---|
| Database: approved fields rewritten from a legacy URL to a canonical URL | **Yes, exactly** — the journal stores the original value of every reference (immutable once recorded) |
| Storage: new objects under `<namespace>/<version>/…` | Not deleted by rollback (additive; harmless; recorded as orphans). Deleting is a separate, manual decision |
| Storage: originals | never modified or deleted |
| CDN: legacy-URL purge requests (only if `cache.purgeLegacyUrls`) | not reversible, but the origin objects still exist so purged URLs repopulate on the next request |
| Journal / reports | local files |

## Semantics

`media-migrate rollback --yes` restores each `UPDATED` reference with a **compare-and-set on the value the tool wrote**:

* field still holds the canonical value → set back to the exact original → reference `ROLLED_BACK`
* field already equals the original → recorded as restored, no write
* field holds anything else (a person edited it since) → **`ROLLBACK_CONFLICT`, not overwritten** (invariant I13), exit 6
* document gone → conflict, reported

An asset becomes `ROLLED_BACK` only when all its references are restored; otherwise it is `RECONCILE_REQUIRED`. Options:
`--from-run <id>` (only references last written by that run), `--asset <id>`, `--limit`, `--dry-run`.

## Procedure

1. **Decide the scope**: everything, one run (`--from-run`), or specific assets.
2. `media-migrate rollback --config … --dry-run --json` → counts of "would restore" vs conflicts. Nothing is written.
3. Announce a short window if admins edit content (conflicts are safe but need manual follow-up).
4. `media-migrate rollback --config … --yes` (production also needs `safety.allowProductionMutations: true`).
5. `media-migrate verify --config …` and `reconcile` (read-only) — canonical URLs should be gone from approved fields.
6. Handle conflicts: each is a field someone changed deliberately; leave it, or restore by hand using the journal
   (`report` → `assets.jsonl`, `logs --level warn`).
7. Application rollback: the frontend helper leaves non-canonical URLs unchanged, so no frontend revert is needed.

## Disaster path (journal lost)

If the journal is unrecoverable and a rollback is required: restore from the MongoDB backup taken before Phase 3 (the
documented prerequisite), or from `<journalDir>/backups/*.sqlite` if present. The destination objects stay valid
regardless; the legacy URLs never stopped working because originals were never touched.

## Verified by

`rollback: restores EXACT original values (database snapshot equality)…`, `…never overwrites a concurrent user edit…`,
`…requires explicit confirmation; dry-run is read-only`, `…a partially completed migration (crash mid-way) can be rolled
back`, `e2e: rollback safeguards…`, and the simulation (`rollbackExact.databaseEqualsOriginal`). **Not yet tested on
staging with real MongoDB.**
