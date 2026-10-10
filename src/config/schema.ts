import { z } from 'zod';

export const CONFIG_VERSION = 1;

const hostPattern = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, 'must be a bare hostname or "*.suffix" (no scheme, path or port)');

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an environment variable NAME (e.g. R2_SECRET), never a secret value');

const s3Storage = z
  .object({
    provider: z.literal('s3'),
    bucket: z.string().min(1),
    endpoint: z.string().url().optional(),
    region: z.string().default('auto'),
    forcePathStyle: z.boolean().default(false),
    accessKeyIdEnv: envName.optional(),
    secretAccessKeyEnv: envName.optional(),
    publicBaseUrl: z.string().url().optional(),
  })
  .strict();

const fsStorage = z
  .object({
    provider: z.literal('fs'),
    bucket: z.string().min(1).default('local'),
    root: z.string().min(1),
    publicBaseUrl: z.string().url().optional(),
  })
  .strict();

const memStorage = z
  .object({ provider: z.literal('memory'), bucket: z.string().min(1).default('memory'), publicBaseUrl: z.string().url().optional() })
  .strict();

export const storageSchema = z.discriminatedUnion('provider', [s3Storage, fsStorage, memStorage]);

const collectionSchema = z
  .object({
    name: z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/),
    /** Field patterns holding media references. ONLY these paths are ever read for rewriting or written. */
    fields: z.array(z.string().min(1)).min(1),
    /** Used by --since/--until. */
    timestampField: z.string().min(1).optional(),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(CONFIG_VERSION),
    environment: z.enum(['development', 'staging', 'production']).default('development'),

    source: z
      .object({
        storage: storageSchema,
        /** Hostnames (or *.suffix) whose URLs map 1:1 onto keys in source.storage. Nothing else is ever rewritten. */
        legacyHosts: z.array(hostPattern).min(1),
        allowHttp: z.boolean().default(false),
        /** Only keys under these prefixes are in scope ([] = everything not excluded). */
        includePrefixes: z.array(z.string()).default([]),
        excludePrefixes: z.array(z.string()).default([]),
      })
      .strict(),

    database: z
      .object({
        provider: z.enum(['mongodb', 'sqlite-docs']),
        uriEnv: envName.optional(),
        database: z.string().min(1).optional(),
        file: z.string().min(1).optional(),
        collections: z.array(collectionSchema).min(1),
        writePolicy: z
          .object({
            mode: z.enum(['single-doc-cas', 'transaction']).default('single-doc-cas'),
            /** Maximum documents per transactional batch (transaction mode only). */
            batchSize: z.number().int().min(1).max(500).default(50),
            referenceUpdates: z.enum(['enabled', 'disabled']).default('enabled'),
          })
          .strict()
          .default({}),
      })
      .strict(),

    destination: z
      .object({
        storage: storageSchema,
        publicBaseUrl: z.string().url(),
        namespace: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/, 'no leading/trailing slash, simple segments only').default('media'),
        namespaceVersion: z.string().regex(/^v[0-9]+$/).default('v1'),
        /** Width whose URL replaces the legacy URL in the database; other widths derive from it. */
        referenceVariantWidth: z.number().int().positive(),
        urlStrategy: z.enum(['variant-path']).default('variant-path'),
        cacheControl: z.string().default('public, max-age=31536000, immutable'),
      })
      .strict(),

    processing: z
      .object({
        widths: z.array(z.number().int().min(16).max(10000)).min(1).default([400, 800, 1200]),
        format: z.enum(['webp', 'avif', 'jpeg']).default('webp'),
        quality: z.number().int().min(1).max(100).default(78),
        effort: z.number().int().min(0).max(9).default(4),
        metadata: z.enum(['strip', 'keep-icc', 'keep-all']).default('strip'),
        allowedInputFormats: z.array(z.enum(['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif'])).min(1).default(['jpeg', 'png', 'webp', 'gif']),
        animated: z.enum(['skip', 'preserve']).default('skip'),
        strictDecode: z.boolean().default(true),
        maxSourceBytes: z.number().int().positive().default(50 * 1024 * 1024),
        maxSourcePixels: z.number().int().positive().default(100_000_000),
        video: z.object({ mode: z.enum(['skip']).default('skip') }).strict().default({}),
        tempDir: z.string().default('.media-migrate/tmp'),
        tempBudgetBytes: z.number().int().positive().default(512 * 1024 * 1024),
        concurrency: z.number().int().min(1).max(64).default(4),
        threadsPerJob: z.number().int().min(1).max(16).default(1),
      })
      .strict()
      .default({}),

    migration: z
      .object({
        journalDir: z.string().default('.media-migrate'),
        checkpointIntervalSec: z.number().min(1).default(15),
        journalBackups: z.number().int().min(0).max(20).default(3),
        batchSize: z.number().int().min(1).max(5000).default(200),
        failureThreshold: z
          .object({ maxFailed: z.number().int().min(0).default(50), maxFailedRatio: z.number().min(0).max(1).default(0.1) })
          .strict()
          .default({}),
        retry: z
          .object({
            maxAttempts: z.number().int().min(1).max(10).default(4),
            baseDelayMs: z.number().int().min(0).default(500),
            maxDelayMs: z.number().int().min(0).default(15_000),
            jitter: z.number().min(0).max(1).default(0.25),
            /** Total passes an item may consume across runs before it is terminally FAILED. */
            maxItemAttempts: z.number().int().min(1).max(20).default(5),
          })
          .strict()
          .default({}),
        timeoutsMs: z
          .object({ download: z.number().int().positive().default(120_000), upload: z.number().int().positive().default(120_000), database: z.number().int().positive().default(30_000) })
          .strict()
          .default({}),
        verification: z
          .object({
            /** full = re-download and hash every destination object; head = size + stored sha256 metadata only. */
            mode: z.enum(['full', 'head']).default('full'),
          })
          .strict()
          .default({}),
        originals: z.object({ retention: z.enum(['keep']).default('keep') }).strict().default({}),
        lockStaleSec: z.number().int().min(10).default(120),
        rateLimitPerSec: z.number().min(0).default(0),
        shutdownGraceSec: z.number().min(1).default(30),
      })
      .strict()
      .default({}),

    cache: z
      .object({
        provider: z.enum(['none', 'cloudflare']).default('none'),
        zoneIdEnv: envName.optional(),
        apiTokenEnv: envName.optional(),
        /** After references are rewritten, purge the OLD per-URL entries. Never zone-wide. */
        purgeLegacyUrls: z.boolean().default(false),
        /** HEAD the new public URL (needs network to the CDN). */
        verifyCdn: z.boolean().default(false),
        /** If CDN verification or purge fails: fail the asset (default) or leave it flagged for retry. */
        onFailure: z.enum(['fail', 'flag']).default('fail'),
      })
      .strict()
      .default({}),

    observability: z
      .object({
        logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        logFile: z.string().optional(),
        reportDir: z.string().default('.media-migrate/reports'),
        summaryIntervalSec: z.number().min(1).default(10),
      })
      .strict()
      .default({}),

    safety: z
      .object({
        /** Must be true for any non-dry-run mutation when environment=production. */
        allowProductionMutations: z.boolean().default(false),
        /** Hosts that must never be treated as legacy hosts even if listed (defence in depth). */
        neverRewriteHosts: z.array(hostPattern).default([]),
      })
      .strict()
      .default({}),

    compatibility: z
      .object({
        routePrefixes: z.array(z.string().regex(/^\/[A-Za-z0-9_\-/]*$/)).default([]),
        mode: z.enum(['redirect', 'stream']).default('redirect'),
        redirectStatus: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).default(308),
        mappingFile: z.string().default('.media-migrate/mapping.jsonl'),
      })
      .strict()
      .default({}),
  })
  .strict();

export type MediaMigrateConfig = z.infer<typeof configSchema>;
export type StorageConfig = z.infer<typeof storageSchema>;
export type CollectionConfig = z.infer<typeof collectionSchema>;
