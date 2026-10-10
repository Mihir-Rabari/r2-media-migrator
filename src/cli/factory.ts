import * as path from 'node:path';
import * as fs from 'node:fs';
import type { CacheInvalidationProvider, CdnVerifier, DatabaseProvider, ProgressReporter, StorageProvider } from '../core/interfaces';
import { LoadedConfig, resolvePath } from '../config/load';
import type { StorageConfig } from '../config/schema';
import { MediaUrlResolver } from '../compatibility/resolver';
import { SqliteJournal } from '../journal/sqliteJournal';
import { MemoryStorage } from '../storage/memoryStorage';
import { FsStorage } from '../storage/fsStorage';
import { S3Storage } from '../storage/s3Storage';
import { MongoDatabase } from '../database/mongoDatabase';
import { SqliteDocDatabase } from '../database/sqliteDocDb';
import { SharpProcessor } from '../processing/imageProcessor';
import { CloudflareCache, HttpCdnVerifier, NoopCache } from '../cache/providers';
import { Failpoints } from '../core/failpoints';
import { Logger } from '../observability/logger';
import type { EngineDeps } from '../migration/context';
import type { ShutdownController } from '../core/shutdown';
import { validationError } from '../domain/errors';

export interface Runtime {
  deps: EngineDeps;
  journal: SqliteJournal;
  close(): Promise<void>;
}

export const journalFile = (l: LoadedConfig): string => path.join(resolvePath(l, l.config.migration.journalDir), 'journal.sqlite');

function buildStorage(l: LoadedConfig, side: 'source' | 'dest'): StorageProvider {
  const sc: StorageConfig = side === 'source' ? l.config.source.storage : l.config.destination.storage;
  const publicBase = side === 'dest' ? l.config.destination.publicBaseUrl : sc.publicBaseUrl ?? `https://${l.config.source.legacyHosts[0].replace(/^\*\./, 'x.')}`;
  const sec = l.secrets;
  switch (sc.provider) {
    case 's3':
      return new S3Storage({
        bucket: sc.bucket, endpoint: sc.endpoint, region: sc.region, forcePathStyle: sc.forcePathStyle, publicBaseUrl: publicBase,
        accessKeyId: side === 'source' ? sec.sourceAccessKeyId : sec.destAccessKeyId,
        secretAccessKey: side === 'source' ? sec.sourceSecretAccessKey : sec.destSecretAccessKey,
        requestTimeoutMs: side === 'source' ? l.config.migration.timeoutsMs.download : l.config.migration.timeoutsMs.upload,
      });
    case 'fs':
      return new FsStorage(sc.bucket, resolvePath(l, sc.root), publicBase);
    case 'memory':
      return new MemoryStorage(sc.bucket, publicBase);
  }
}

const sameStorage = (a: StorageConfig, b: StorageConfig): boolean => JSON.stringify(a) === JSON.stringify({ ...b });

export function buildDatabase(l: LoadedConfig): DatabaseProvider {
  const d = l.config.database;
  if (d.provider === 'mongodb') return new MongoDatabase({ uri: l.secrets.mongoUri!, database: d.database });
  return new SqliteDocDatabase(resolvePath(l, d.file!));
}

export function buildResolver(l: LoadedConfig, source: StorageProvider, mapping: Iterable<import('../compatibility/resolver').MappingEntry> = []): MediaUrlResolver {
  const c = l.config;
  return new MediaUrlResolver(
    {
      legacyHosts: c.source.legacyHosts, neverRewriteHosts: c.safety.neverRewriteHosts, allowHttp: c.source.allowHttp, sourceProvider: source.kind, sourceBucket: source.bucket,
      includePrefixes: c.source.includePrefixes, excludePrefixes: c.source.excludePrefixes, publicBaseUrl: c.destination.publicBaseUrl, namespace: c.destination.namespace,
      namespaceVersion: c.destination.namespaceVersion, widths: c.processing.widths, format: c.processing.format, referenceVariantWidth: c.destination.referenceVariantWidth,
    },
    mapping,
  );
}

export function buildCache(l: LoadedConfig): { cache: CacheInvalidationProvider; cdn: CdnVerifier | null } {
  const c = l.config;
  const destHost = new URL(c.destination.publicBaseUrl).hostname;
  const cache =
    c.cache.provider === 'cloudflare'
      ? new CloudflareCache({ zoneId: l.secrets.cloudflareZoneId!, apiToken: l.secrets.cloudflareToken!, allowedHosts: [...c.source.legacyHosts, destHost] })
      : new NoopCache();
  const cdn = c.cache.verifyCdn ? new HttpCdnVerifier([destHost]) : null;
  return { cache, cdn };
}

export interface RuntimeOptions {
  dryRun: boolean;
  mutationAuthorized: boolean;
  reporter: ProgressReporter;
  shutdown: ShutdownController;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  env: NodeJS.ProcessEnv;
}

export function buildRuntime(l: LoadedConfig, o: RuntimeOptions): Runtime {
  const c = l.config;
  const jf = journalFile(l);
  const journal = new SqliteJournal(jf);
  const source = buildStorage(l, 'source');
  const dest = sameStorage(c.source.storage, c.destination.storage) ? source : buildStorage(l, 'dest');
  const db = buildDatabase(l);
  const { cache, cdn } = buildCache(l);
  const resolver = buildResolver(l, source);
  const logFile = c.observability.logFile ? resolvePath(l, c.observability.logFile) : path.join(resolvePath(l, c.migration.journalDir), 'logs', 'media-migrate.log');
  const logger = new Logger({ level: o.verbose ? 'debug' : c.observability.logLevel, journal, file: logFile, stderr: !o.json, quiet: o.quiet, verbose: o.verbose });
  const processor = new SharpProcessor({ threads: c.processing.threadsPerJob, allowedInputFormats: c.processing.allowedInputFormats, strictDecode: c.processing.strictDecode });
  const deps: EngineDeps = {
    cfg: c, processingFingerprint: l.processingFingerprint, configFingerprint: l.configFingerprint,
    paths: { tempDir: resolvePath(l, c.processing.tempDir), journalDir: resolvePath(l, c.migration.journalDir), reportDir: resolvePath(l, c.observability.reportDir) },
    journal, source, dest, db, processor, cache, cdn, resolver, logger, reporter: o.reporter,
    failpoints: Failpoints.fromEnv(o.env), shutdown: o.shutdown, dryRun: o.dryRun, mutationAuthorized: o.mutationAuthorized,
  };
  if (!fs.existsSync(path.dirname(jf))) fs.mkdirSync(path.dirname(jf), { recursive: true });
  return {
    deps, journal,
    async close() {
      logger.close();
      await db.close().catch(() => undefined);
      journal.close();
    },
  };
}

export function requireConfigPath(p: string | undefined): string {
  if (!p) throw validationError('CONFIG_REQUIRED', 'this command needs --config <file>');
  return p;
}
