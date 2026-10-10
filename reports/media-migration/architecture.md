# Architecture decision record: media-migrate

Status: accepted (initial). Written before implementation; later reports amend where reality differed.

## 1. Verified facts about the existing system (V2 Enterprise)

Source: direct inspection of `K:\Projects\V2-enterprise` (branch `dev`, HEAD `401444d`) and its own
`reports/media-and-bundle-investigation.md` (which records live-network observations; those are
*quoted*, not re-measured here).

| Area | Fact | Evidence |
|---|---|---|
| Layout | Two packages, no workspace: `backend/` (Express 4, Mongoose 9, TS) and `frontend/` (Vite/React 19). Deployed with `deploy.sh`/`deploy.ps1`, run by PM2 (`ecosystem.config.js`, fork mode, 1 instance). | repo root |
| Package manager | npm, per-package `package-lock.json`. | lockfiles |
| Tests | Backend: `node --test` via ts-node, 8 tests. Baseline run: **8 pass / 0 fail**; `tsc --noEmit` clean. No frontend tests. No CI config. | ran `npm test`, `npx tsc --noEmit` in `backend/` |
| Upload path | Browser -> `POST /api/v1/admin/upload` -> multer temp file -> `uploadToR2()` (`backend/src/utils/r2.ts`): one `PutObject`, `ContentType` only, no `Cache-Control`, no resize. Key = `<folder>/<Date.now()>-<rand>-<name>`. | `r2.ts`, `admin.routes.ts` |
| URL storage | Absolute `${R2_PUBLIC_URL}/${key}` stored verbatim in MongoDB. | `r2.ts`, models |
| Background work | None. PM2 only supervises the web process. | no worker code |
| Secrets | `dotenv` + zod (`backend/src/config/env.ts`); `R2_*` vars. `.env.example` is stale (mentions Postgres/Cloudinary). | `env.ts`, `.env.example` |
| Media-bearing models | See `media-reference-map.md`. | `backend/src/models/*.ts` |
| Frontend choke point | Every image goes through `getOptimizedImageUrl()` in `frontend/src/utils/mediaUtils.ts`, which only understands ImageKit and returns every other URL unchanged. | grep of call sites |
| Delivery (quoted) | `cdn.v2enterprise.in` is a Cloudflare custom domain on the R2 bucket; edge HIT, `max-age=604800`. `pub-*.r2.dev` is the legacy public URL (152 product URLs). `?width=` and `/cdn-cgi/image/` not honoured. | investigation report §1-2 |
| Consequence | An Express route can **not** see requests sent straight to `cdn.v2enterprise.in`; they never reach our app. | network path above |

Build/test environment: Windows 11, Node v24.15.0, `sharp` 0.34 (libvips with `heif`/AV1), `ffmpeg`/`ffprobe`
on PATH, **no `mongod`, Docker daemon not running**, no R2 credentials. Real-service integration is therefore
limited; see `validation-results.md` and `known-limitations.md`.

## 2. Decision summary

A standalone, reusable Node/TypeScript CLI (`media-migrate`, this repo) with a provider-agnostic core. V2
Enterprise is *configuration* (`examples/v2-enterprise.config.json`) plus one small frontend helper change. No V2
collection names, hosts or schemas appear in `src/`.

### Module boundaries (`src/`)

| Module | Responsibility | May depend on |
|---|---|---|
| `domain` | Types, states, transition table, asset IDs, object keys, errors, exit codes | nothing |
| `core` | Provider **interfaces**, failpoints, dry-run guards, retry, bounded pool, byte budget | domain |
| `config` | zod schema, loader (file < env < CLI), versioned migrations, unsafe-combo validation | domain, security |
| `security` | Redaction, host allow-list, object-key validation, safe paths | domain |
| `journal` | SQLite (`node:sqlite`) implementation of `MigrationJournal`, `AssetManifestRepository`, `CheckpointStore`, run lock | core, domain |
| `storage` | `StorageProvider`: S3/R2, filesystem, in-memory | core |
| `database` | `DatabaseProvider`: MongoDB, SQLite document store (fake + local) | core |
| `processing` | `MediaProcessor` (sharp), content sniffing, video capability probe | core |
| `inventory` | Reference scan, URL->source-key mapping, field discovery | core, security |
| `migration` | Engine (stage runner), verify, reconcile, rollback | interfaces only |
| `compatibility` | URL resolver, mapping export, framework-neutral HTTP handler | domain, security, core |
| `cache` | `CacheInvalidationProvider`: Cloudflare, no-op, fake; CDN verifier | core |
| `observability`/`reporting` | Logger, progress derived from journal, run reports | journal |
| `cli` | Argument parsing, commands, background launcher, provider factory | all |

The engine imports **only** `core` interfaces; Express, Mongoose, Cloudflare and `@aws-sdk/*` are reached solely
through adapters built in `cli/factory.ts`.

## 3. State management and journaling

* **Authoritative store: SQLite via Node's built-in `node:sqlite`** (WAL, `synchronous=FULL`, `BEGIN IMMEDIATE`
  transactions). No extra dependency, crash-safe, multi-process safe, queryable for `status`/`report`.
* Tables: `runs`, `assets` (manifest), `variants`, `refs` (per-DB-location records holding the *exact previous
  value*), `events` (append-only audit), `orphans`, `cache_ops`, `checkpoints`, `lock`, `meta`.
* **JSONL is export-only** (reports, resolver mapping). Never the source of truth.
* Every transition is one SQL transaction that also appends an `events` row and is validated against the table
  in `domain/stateMachine.ts`.
* Item identity = `assetId` (§6). Run identity = `run_<utc-timestamp>_<random>`.

## 4. Transaction boundaries (what is and is not atomic)

Mongo + R2 + disk + CDN is **not** one transaction; nothing here claims otherwise. Atomic units:

1. *Journal*: transition + event = one SQLite transaction.
2. *Database*: one document's approved-field update = one single-document operation with a compare-and-set
   filter (`{_id, <path>: expectedValue}`), atomic in MongoDB. Multi-document transactions are **optional**
   (`database.writePolicy.mode = "transaction"`), only when the topology supports them (detected from `hello`:
   replica set or mongos), bounded to `batchSize`, never open across storage/CDN I/O. Default `single-doc-cas`.
3. *Storage*: each PUT is atomic at the provider; keys are immutable so re-PUT of identical bytes is idempotent.

Ordering law (I1/I7): **write objects -> verify by size+sha256 -> only then CAS the DB field -> record -> cache
stage -> COMPLETE.** Intent is journaled *before* each irreversible step and the outcome *after*; the gap is
resolved by observing real state on restart (§5).

## 5. Failure and recovery model

Recovery = **reconciliation against observed reality**, not replay of intent.

* Stages are idempotent and keyed deterministically (`sha256(scope|assetId|stage|profileHash)`).
* On restart, items in `PROCESSING`/`ASSETS_WRITTEN`/... are re-driven from durable state. Verified existing
  objects are reused (head + sha256 metadata) rather than regenerated.
* A reference in `UPDATING` (intent logged, outcome unknown) is resolved by reading the document: value == old
  -> retry CAS; value == new -> mark `UPDATED` (crash after DB write); anything else -> `CONFLICT`, never
  overwritten.
* Crash = process dies without cleanup. A stale run lock (dead PID on same host, or expired heartbeat) is taken
  over atomically; the interrupted run is marked `INTERRUPTED`, never `COMPLETE`.
* A run is `COMPLETE` only if every in-scope asset is `COMPLETE`/policy-`SKIPPED` and there are zero conflicts,
  failures or unresolved cache operations; otherwise `INCOMPLETE` (exit 4) or `FAILED`.
* Per-item retry budget with exponential backoff + jitter; exhaustion = terminal `FAILED`, re-armed only by the
  explicit `retry` command.
* Full matrix: `recovery-matrix.md`.

## 6. Identity, layout, compatibility

* `assetId = "a" + base32(sha256(provider|bucket|normalizedSourceKey))[0..24]` (location-derived: stable and
  known at plan time). The **content sha256** is stored and re-checked; a change between attempts yields
  `CONFLICT(source-changed)`. Filename-only identity is rejected. Byte-identical sources are *reported* as
  duplicate groups but keep separate identities (merging them would change DB semantics).
* Layout: `<namespace>/<version>/<assetId>/<width>.<ext>`. Originals are **reused in place**.
* DB reference is rewritten to the **reference variant** URL (`destination.referenceVariantWidth`); other widths
  derive deterministically so the frontend needs no per-image lookup.
* **Resolver** is mapping-driven: only verified, exported assets resolve (no guessing). Idempotent; hosts not
  allow-listed are `external` and untouched (I4).
* **Compat HTTP handler** (plain Node `req/res`, usable as Express middleware) serves only requests that reach
  our app: precise prefix match, redirect or bounded stream, HEAD/GET/Range/conditional. It cannot affect
  `cdn.v2enterprise.in` traffic; that needs a Cloudflare Worker/redirect rule, documented but never applied by
  the tool.

## 7. Cache model

Versioned immutable URLs mean new assets need **no purge**. Separately journaled facts per asset:
`destination_verified`, `cdn_verified`, `purge_requested`, `purge_confirmed` (API acceptance only; propagation
and browser caches are explicitly *not* claimed), legacy URL policy. Purging is per-URL only (<=30/call), scoped
to the configured public host; zone-wide purge is not implemented. Purge failure leaves the asset at
`REFERENCES_UPDATED` with cache op `FAILED`, run result `INCOMPLETE`, recoverable by `retry`.

## 8. Security assumptions

Operator config is trusted; DB and bucket contents are not. Hosts allow-listed; keys validated (no `..`, control
chars, absolute paths, backslashes); no arbitrary URL fetching (reads go through `StorageProvider` with validated
keys; optional CDN HEAD only to the configured public host); no shell (ffprobe via `execFile` argv); secrets only
via env vars named in config and redacted everywhere; decompression-bomb limits; production mutation needs config
opt-in **and** `--yes`; dry-run enforced by wrapper providers that throw on any mutation.

## 9. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Single append-only JSON/JSONL manifest as source of truth | Unsafe for concurrent writers / torn writes; no atomic multi-row update. Export only. |
| MongoDB-backed journal | Couples tool to the DB being migrated; fails when the DB is the problem; not portable. |
| One big Mongo transaction | Unsupported on standalone servers, held across slow I/O, size limits. |
| Cloudflare Image Resizing | Verified not honoured on the zone (investigation report). Possible future URL strategy. |
| BullMQ/Redis worker | New infrastructure not in the stack; detached worker + durable journal is simpler. |
| Filename-derived identity | Collisions and duplicates (3 byte-identical files observed). |
| Moving/deleting originals | Violates I9; belongs to a future explicit retention command. |
| Express dependency in the handler | Core must not depend on Express. |
