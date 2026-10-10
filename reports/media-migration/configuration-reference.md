# Configuration reference

The configuration is a versioned document (`"version": 1`), validated at runtime with a strict schema (unknown keys are
errors, so typos cannot silently change behaviour). The table of keys, types and defaults below is **generated from the
schema** (`npm run docs:config`); the sections after it document semantics.

Complete examples: [`examples/full.config.json`](../../examples/full.config.json), minimal:
[`examples/minimal.config.json`](../../examples/minimal.config.json), V2 Enterprise:
[`examples/v2-enterprise.config.json`](../../examples/v2-enterprise.config.json).

## Sources and precedence

1. **Defaults** (schema)
2. **Config file** (`--config`; `.json`, `.js`, `.cjs`, `.mjs`, `.ts`)
3. **Environment**: `MEDIA_MIGRATE__<path>__<path>=<json-or-string>` (double underscore separates path segments), e.g.
   `MEDIA_MIGRATE__processing__concurrency=8`. Aliases: `MEDIA_MIGRATE_ENV`, `MEDIA_MIGRATE_JOURNAL_DIR`,
   `MEDIA_MIGRATE_REPORT_DIR`, `MEDIA_MIGRATE_LOG_LEVEL`, `MEDIA_MIGRATE_CONCURRENCY`.
4. **CLI**: `--set path=value` (repeatable), `--env`, `--concurrency`, `--batch-size`.

The **merged** result is validated (schema + cross-field rules) before anything is created or contacted. Relative paths
resolve against the config file's directory.

## Secrets

Secrets are **never** in the file. The file names environment variables (`accessKeyIdEnv`, `secretAccessKeyEnv`, `uriEnv`,
`zoneIdEnv`, `apiTokenEnv`); the schema rejects anything that is not an upper-case env-var *name*, and rejects inline
`secretAccessKey`-style keys outright. Resolved values are registered with the process-wide redactor, which scrubs logs,
journal events, reports, error messages and `config validate` output. Missing required secrets fail validation (exit 2)
naming the variable, never its value.

| Variable (V2 Enterprise names) | Used for |
|---|---|
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | S3-compatible storage (R2). Least privilege: read on source prefixes; write on `media/` only; **no delete** |
| `MONGODB_URI` | MongoDB connection string (user needs `find` + `update` on the approved collections only) |
| `CF_ZONE_ID`, `CF_API_TOKEN` | Cloudflare per-URL cache purge (token scope: Zone → Cache Purge) |
| `MEDIA_MIGRATE_ENABLE_FAILPOINTS`, `MEDIA_MIGRATE_FAILPOINTS` | **Test-only** fault injection; ignored unless the first is `1` |
| `MEDIA_MIGRATE_TEST_S3_*`, `MEDIA_MIGRATE_TEST_MONGO_URI` | Opt-in real-service contract tests |

## Storage providers

| `provider` | Keys | Use |
|---|---|---|
| `s3` | `bucket`, `endpoint`, `region` (default `auto`), `forcePathStyle`, `accessKeyIdEnv`, `secretAccessKeyEnv` | Cloudflare R2, AWS S3, MinIO. SDK retries are disabled: the engine owns bounded, counted retries. |
| `fs` | `root`, `bucket` | Local directory (`objects/` + `meta/`); rehearsals and end-to-end tests |
| `memory` | `bucket` | Tests only; refused in production |

Source and destination may be the **same bucket** (the V2 case). The destination namespace (`<namespace>/<version>/`) is
then excluded from the source inventory, and `source.includePrefixes` overlapping it is a validation error.

## Database providers

| `provider` | Keys |
|---|---|
| `mongodb` | `uriEnv`, optional `database` (else the database in the URI), `collections[]`, `writePolicy` |
| `sqlite-docs` | `file`, `collections[]` — a local document store for rehearsals/tests |

`collections[].fields` is the **only** thing that can be read as a reference or written. Field patterns use dotted paths
with `[]` for arrays. `_id`, operator-looking segments (`$where`) and prototype keys are rejected.

## Cross-field rules enforced at validation

widths strictly ascending and `referenceVariantWidth ∈ widths`; `format` supported by the installed libvips (avif is
checked, not assumed); `publicBaseUrl` https (http only in `development`), no credentials; no duplicate collections; no
`_id` field; source prefixes must not overlap the destination namespace; legacy hosts must be bare hostnames (broad
wildcards rejected; wildcards on shared public suffixes such as `*.r2.dev` produce a warning — pin the exact host);
`neverRewriteHosts` ∩ `legacyHosts` = ∅; `tempBudgetBytes ≥ maxSourceBytes`; `retry.maxDelayMs ≥ baseDelayMs`; cache
provider consistency; production: memory storage refused, `allowHttp` refused, `verification.mode=head` warned.
`--fail-on-warning` turns warnings into exit 2.

## Versioning and migration strategy

* `version` is mandatory in new files; a missing version is treated as `0`.
* `src/config/load.ts` holds an ordered table `CONFIG_MIGRATIONS[n]: v(n) → v(n+1)`. Loading applies the chain, then
  validates against the *current* schema. The applied steps are reported by `config validate`.
* A config newer than the tool is refused (`CONFIG_TOO_NEW`) rather than guessed at.
* Changing anything that affects *what is produced* (field map, destination layout, transformation profile, legacy
  hosts, cache semantics) changes the **semantic fingerprint**; a run cannot be resumed under a different fingerprint,
  and readiness attestations are bound to it. Operational tuning (concurrency, batch size, temp dir, timeouts, logging)
  is deliberately excluded so a run can be resumed with different tuning.

## All keys

<!-- BEGIN GENERATED -->
| Key | Type | Default | Notes |
|---|---|---|---|
| `version` | 1 | **required** | Config schema version (currently 1). Older versions are migrated automatically; newer ones are refused. |
| `environment` | "development" \| "staging" \| "production" | `"development"` | `production` enables extra gates: `safety.allowProductionMutations`, `--yes` and the readiness checklist. |
| `source` | object |  |  |
| `source.storage` | object (provider: s3 \| fs \| memory) |  | see Storage providers below |
| `source.legacyHosts` | string[] | **required** | Only URLs on these hosts are ever mapped to a bucket key. `*.suffix` wildcards allowed (pin exact hosts for shared suffixes like r2.dev). |
| `source.allowHttp` | boolean | `false` |  |
| `source.includePrefixes` | string[] | `[]` | If non-empty, only keys under these prefixes are in scope. |
| `source.excludePrefixes` | string[] | `[]` | Keys under these prefixes are never touched. The destination namespace is always excluded. |
| `database` | object |  |  |
| `database.provider` | "mongodb" \| "sqlite-docs" | **required** |  |
| `database.uriEnv` | string | (optional) |  |
| `database.database` | string | (optional) |  |
| `database.file` | string | (optional) |  |
| `database.collections` | object[] | **required** | THE approved field map. Only these paths are read as references and written. `a[]` iterates arrays: `photos[]`, `home.cats[].image`. |
| `database.writePolicy` | object |  |  |
| `database.writePolicy.mode` | "single-doc-cas" \| "transaction" | `"single-doc-cas"` | `single-doc-cas` (default) or `transaction` (needs replica set / mongos, verified at run time). |
| `database.writePolicy.batchSize` | number | `50` |  |
| `database.writePolicy.referenceUpdates` | "enabled" \| "disabled" | `"enabled"` | `disabled` allows `process` only; `migrate` refuses. |
| `destination` | object |  |  |
| `destination.storage` | object (provider: s3 \| fs \| memory) |  | see Storage providers below |
| `destination.publicBaseUrl` | string | **required** |  |
| `destination.namespace` | string | `"media"` |  |
| `destination.namespaceVersion` | string | `"v1"` | Bump when processing settings change: variants are immutable and are never overwritten. |
| `destination.referenceVariantWidth` | number | **required** | Width whose URL is written into database fields. Must be one of `processing.widths`. |
| `destination.urlStrategy` | "variant-path" | `"variant-path"` |  |
| `destination.cacheControl` | string | `"public, max-age=31536000, immutable"` |  |
| `processing` | object |  |  |
| `processing.widths` | number[] | `[400,800,1200]` | Maximum widths (never upscaled). Strictly ascending. |
| `processing.format` | "webp" \| "avif" \| "jpeg" | `"webp"` | `avif` only if the installed sharp build supports it (checked at validation). |
| `processing.quality` | number | `78` |  |
| `processing.effort` | number | `4` |  |
| `processing.metadata` | "strip" \| "keep-icc" \| "keep-all" | `"strip"` |  |
| `processing.allowedInputFormats` | "jpeg" \| "png" \| "webp" \| "gif" \| "tiff" \| "avif"[] | `["jpeg","png","webp","gif"]` |  |
| `processing.animated` | "skip" \| "preserve" | `"skip"` | `skip` leaves animated images alone (SKIPPED); `preserve` re-encodes animations. |
| `processing.strictDecode` | boolean | `true` | Fail on decoder warnings (catches truncated JPEGs). |
| `processing.maxSourceBytes` | number | `52428800` |  |
| `processing.maxSourcePixels` | number | `100000000` |  |
| `processing.video` | object |  |  |
| `processing.video.mode` | "skip" | `"skip"` |  |
| `processing.tempDir` | string | `".media-migrate/tmp"` |  |
| `processing.tempBudgetBytes` | number | `536870912` | Byte-weighted semaphore bounding concurrent temp files. Must be >= `maxSourceBytes`. |
| `processing.concurrency` | number | `4` |  |
| `processing.threadsPerJob` | number | `1` |  |
| `migration` | object |  |  |
| `migration.journalDir` | string | `".media-migrate"` |  |
| `migration.checkpointIntervalSec` | number | `15` |  |
| `migration.journalBackups` | number | `3` |  |
| `migration.batchSize` | number | `200` |  |
| `migration.failureThreshold` | object |  |  |
| `migration.failureThreshold.maxFailed` | number | `50` |  |
| `migration.failureThreshold.maxFailedRatio` | number | `0.1` |  |
| `migration.retry` | object |  |  |
| `migration.retry.maxAttempts` | number | `4` |  |
| `migration.retry.baseDelayMs` | number | `500` |  |
| `migration.retry.maxDelayMs` | number | `15000` |  |
| `migration.retry.jitter` | number | `0.25` |  |
| `migration.retry.maxItemAttempts` | number | `5` | Total passes (including crash recoveries) an item may consume before terminal FAILED. |
| `migration.timeoutsMs` | object |  |  |
| `migration.timeoutsMs.download` | number | `120000` |  |
| `migration.timeoutsMs.upload` | number | `120000` |  |
| `migration.timeoutsMs.database` | number | `30000` |  |
| `migration.verification` | object |  |  |
| `migration.verification.mode` | "full" \| "head" | `"full"` | `full` re-reads and re-hashes every destination object; `head` trusts size + stored sha256 metadata. |
| `migration.originals` | object |  |  |
| `migration.originals.retention` | "keep" | `"keep"` |  |
| `migration.lockStaleSec` | number | `120` |  |
| `migration.rateLimitPerSec` | number | `0` |  |
| `migration.shutdownGraceSec` | number | `30` |  |
| `cache` | object |  |  |
| `cache.provider` | "none" \| "cloudflare" | `"none"` | `none` or `cloudflare` (per-URL purge only). |
| `cache.zoneIdEnv` | string | (optional) |  |
| `cache.apiTokenEnv` | string | (optional) |  |
| `cache.purgeLegacyUrls` | boolean | `false` | Purge the OLD per-URL entries after references are rewritten. Never zone-wide. |
| `cache.verifyCdn` | boolean | `false` |  |
| `cache.onFailure` | "fail" \| "flag" | `"fail"` |  |
| `observability` | object |  |  |
| `observability.logLevel` | "debug" \| "info" \| "warn" \| "error" | `"info"` |  |
| `observability.logFile` | string | (optional) |  |
| `observability.reportDir` | string | `".media-migrate/reports"` |  |
| `observability.summaryIntervalSec` | number | `10` |  |
| `safety` | object |  |  |
| `safety.allowProductionMutations` | boolean | `false` | Must be true for any non-dry-run mutation when `environment=production`. |
| `safety.neverRewriteHosts` | string[] | `[]` | Defence in depth: hosts that are never treated as legacy even if matched. |
| `compatibility` | object |  |  |
| `compatibility.routePrefixes` | string[] | `[]` | Path prefixes owned by the legacy-URL HTTP handler (only matters for requests that reach your app). |
| `compatibility.mode` | "redirect" \| "stream" | `"redirect"` |  |
| `compatibility.redirectStatus` | 301 \| 302 \| 307 \| 308 | `308` |  |
| `compatibility.mappingFile` | string | `".media-migrate/mapping.jsonl"` |  |
<!-- END GENERATED -->
