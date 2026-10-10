# State machine

Every migration item (an *asset*, identified by `assetId`) and every database *reference* has a durable state in the
SQLite journal. Transitions are validated in code (`src/domain/stateMachine.ts`); an illegal transition throws
`ILLEGAL_TRANSITION` and is covered by tests (`tests/unit/core.test.ts`, `tests/unit/journal.test.ts`).

## Happy path

```
DISCOVERED -> PLANNED -> PROCESSING -> ASSETS_WRITTEN -> DESTINATION_VERIFIED
           -> REFERENCES_UPDATED -> CACHE_HANDLED -> COMPLETE
```

| State | Meaning | Durable evidence required to *enter* it |
|---|---|---|
| `DISCOVERED` | A legacy reference to this source object exists in an approved field | asset row + reference rows (original value stored) |
| `PLANNED` | Source exists (HEAD), is an image within size limits | source size/type recorded |
| `PROCESSING` | A worker is (or was) downloading/transforming/uploading | `attempts` incremented (poison-pill guard) |
| `ASSETS_WRITTEN` | Every configured variant was uploaded (or found identical at the destination) | variant rows with sha256/bytes, `verified=0` |
| `DESTINATION_VERIFIED` | Every variant re-read: size, content-type, sha256 match | all variant rows `verified=1` |
| `REFERENCES_UPDATED` | Every reference was compare-and-set to the canonical URL | all reference rows `UPDATED` |
| `CACHE_HANDLED` | Optional CDN verification / legacy-URL purge finished | cache status `NOT_REQUIRED` or `CONFIRMED` |
| `COMPLETE` | Postconditions re-checked (I7) | see `assertPostconditions` |

## Side states

| State | Meaning | How it is left |
|---|---|---|
| `SKIPPED` | Policy decision (video, SVG, animated with `animated=skip`, unsupported content/format, too large). References are **never** rewritten. | `retry` after a policy/config change |
| `SOURCE_MISSING` | HEAD/GET says the original does not exist. References untouched. | restore the object, then `retry` |
| `FAILED` | Retry budget exhausted or permanent error (corrupt image, post-condition failure, cache failure with `onFailure=fail`). **Terminal until an operator runs `retry`.** | `retry --yes` |
| `CONFLICT` | Concurrent modification detected (document changed, source changed, destination key occupied). Nothing was overwritten. | operator fixes data, then `retry --yes` |
| `ROLLED_BACK` | Every reference restored to its exact original value | re-running `migrate` re-arms it when the legacy value is seen again |
| `RECONCILE_REQUIRED` | Real state disagrees with the journal (set by reconcile / rollback conflicts / new references discovered for a finished asset) | `reconcile --fix`, `migrate` |

Reference states: `PENDING -> UPDATING -> UPDATED`, with `CONFLICT`, `ROLLED_BACK`, `ROLLBACK_CONFLICT`.
`UPDATING` is the **intent** record, written before the database write; it is resolved by *observing* the document on
recovery (value == old -> retry the compare-and-set; value == new -> adopt as `UPDATED`; anything else -> `CONFLICT`).

## Run states

`CREATED -> RUNNING -> COMPLETE | INCOMPLETE | FAILED | INTERRUPTED` (`DRY_RUN_COMPLETE`, `ROLLED_BACK` for those run kinds).

* `COMPLETE` is returned **only** when every in-scope asset is `COMPLETE` or policy-`SKIPPED` and there are zero
  reference conflicts. Anything else is `INCOMPLETE` (exit 4).
* A process that dies leaves its run `RUNNING` with a lock whose PID is dead; `status` reports it as
  `INTERRUPTED (stale)` and the next run atomically takes the lock over and marks the old run `INTERRUPTED`.
* `--limit`, `--since/--until` and `retry` produce *partial-scope* runs, labelled as such in every report.

<!-- BEGIN GENERATED -->
### Asset transitions (generated from `src/domain/stateMachine.ts`)

| From | Legal next states |
|---|---|
| `DISCOVERED` | `PLANNED`, `SKIPPED`, `SOURCE_MISSING`, `FAILED` |
| `PLANNED` | `PROCESSING`, `SKIPPED`, `SOURCE_MISSING`, `FAILED` |
| `PROCESSING` | `ASSETS_WRITTEN`, `FAILED`, `SOURCE_MISSING`, `SKIPPED`, `CONFLICT` |
| `ASSETS_WRITTEN` | `DESTINATION_VERIFIED`, `PROCESSING`, `FAILED` |
| `DESTINATION_VERIFIED` | `REFERENCES_UPDATED`, `COMPLETE`, `FAILED`, `CONFLICT`, `ROLLED_BACK`, `RECONCILE_REQUIRED` |
| `REFERENCES_UPDATED` | `CACHE_HANDLED`, `FAILED`, `CONFLICT`, `ROLLED_BACK`, `RECONCILE_REQUIRED` |
| `CACHE_HANDLED` | `COMPLETE`, `FAILED`, `ROLLED_BACK`, `RECONCILE_REQUIRED` |
| `COMPLETE` | `ROLLED_BACK`, `RECONCILE_REQUIRED` |
| `FAILED` | `PLANNED`, `RECONCILE_REQUIRED`, `ROLLED_BACK` |
| `SKIPPED` | `PLANNED` |
| `SOURCE_MISSING` | `PLANNED` |
| `CONFLICT` | `PLANNED`, `ROLLED_BACK`, `RECONCILE_REQUIRED` |
| `ROLLED_BACK` | `PLANNED` |
| `RECONCILE_REQUIRED` | `PLANNED`, `DESTINATION_VERIFIED`, `ROLLED_BACK`, `FAILED` |

### Reference transitions (generated)

| From | Legal next states |
|---|---|
| `PENDING` | `UPDATING`, `CONFLICT`, `UPDATED` |
| `UPDATING` | `UPDATED`, `PENDING`, `CONFLICT` |
| `UPDATED` | `ROLLED_BACK`, `ROLLBACK_CONFLICT` |
| `CONFLICT` | `PENDING` |
| `ROLLED_BACK` | `PENDING` |
| `ROLLBACK_CONFLICT` | `ROLLED_BACK`, `UPDATED` |
<!-- END GENERATED -->
