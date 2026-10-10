import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configSchema, MediaMigrateConfig } from '../config/schema';
import { MediaUrlResolver } from '../compatibility/resolver';
import { SqliteJournal } from '../journal/sqliteJournal';
import { MemoryStorage } from '../storage/memoryStorage';
import { SqliteDocDatabase } from '../database/sqliteDocDb';
import { SharpProcessor } from '../processing/imageProcessor';
import { FakeCache } from '../cache/providers';
import { Failpoints } from '../core/failpoints';
import { ShutdownController } from '../core/shutdown';
import { Logger } from '../observability/logger';
import { CollectingReporter } from '../observability/logger';
import { MigrationEngine } from '../migration/engine';
import type { EngineDeps } from '../migration/context';
import { fingerprint } from '../domain/ids';
import { jpegFixture, pngFixture } from './fixtures';

export const LEGACY_HOST = 'cdn.legacy.test';
export const NEW_BASE = 'https://cdn.new.test';

export function testConfig(over: Record<string, any> = {}): MediaMigrateConfig {
  const base: Record<string, any> = {
    version: 1,
    environment: 'staging',
    source: { storage: { provider: 'memory', bucket: 'bkt' }, legacyHosts: [LEGACY_HOST, '*.r2.dev'] },
    database: {
      provider: 'sqlite-docs', file: ':memory:',
      collections: [
        { name: 'products', fields: ['photo', 'photos[]', 'hoverImage'], timestampField: 'updatedAt' },
        { name: 'settings', fields: ['logoImage', 'homeSections.categories[].image'] },
      ],
    },
    destination: { storage: { provider: 'memory', bucket: 'bkt' }, publicBaseUrl: NEW_BASE, referenceVariantWidth: 400 },
    processing: { widths: [100, 200, 400], quality: 70, effort: 2, concurrency: 3, tempBudgetBytes: 256 * 1024 * 1024, maxSourceBytes: 20 * 1024 * 1024 },
    migration: { retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0, maxItemAttempts: 4 }, checkpointIntervalSec: 1, journalBackups: 0, failureThreshold: { maxFailed: 1000, maxFailedRatio: 1 } },
    observability: { logLevel: 'error' },
  };
  return configSchema.parse(deepAssign(base, over));
}

function deepAssign(a: any, b: any): any {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepAssign(a[k], v) : v;
  return out;
}

export interface World {
  dir: string;
  cfg: MediaMigrateConfig;
  journalFile: string;
  storage: MemoryStorage;
  db: SqliteDocDatabase;
  cache: FakeCache;
  failpoints: Failpoints;
  reporter: CollectingReporter;
  journal: SqliteJournal;
  resolver: MediaUrlResolver;
  shutdown: ShutdownController;
  /** Build an engine over the current journal connection. */
  engine(o?: Partial<EngineDeps>): MigrationEngine;
  /** Simulate a process restart: close and reopen the journal (storage/db survive, as they would in production). */
  restart(): void;
  seedImage(key: string, buf: Buffer, contentType?: string): string;
  url(key: string, host?: string): string;
  cleanup(): void;
  nextPid: number;
}

export function makeWorld(cfgOver: Record<string, any> = {}): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-'));
  const cfg = testConfig(cfgOver);
  const journalFile = path.join(dir, 'journal', 'journal.sqlite');
  const storage = new MemoryStorage('bkt', NEW_BASE);
  const db = new SqliteDocDatabase(':memory:');
  const cache = new FakeCache([LEGACY_HOST, '*.r2.dev', 'cdn.new.test']);
  const world: World = {
    dir, cfg, journalFile, storage, db, cache, failpoints: new Failpoints(), reporter: new CollectingReporter(),
    journal: new SqliteJournal(journalFile),
    resolver: undefined as never, shutdown: new ShutdownController(), nextPid: 5000,
    engine(o = {}) {
      const resolver = new MediaUrlResolver({
        legacyHosts: cfg.source.legacyHosts, neverRewriteHosts: cfg.safety.neverRewriteHosts, sourceProvider: storage.kind, sourceBucket: storage.bucket,
        includePrefixes: cfg.source.includePrefixes, excludePrefixes: cfg.source.excludePrefixes, publicBaseUrl: cfg.destination.publicBaseUrl,
        namespace: cfg.destination.namespace, namespaceVersion: cfg.destination.namespaceVersion, widths: cfg.processing.widths,
        format: cfg.processing.format, referenceVariantWidth: cfg.destination.referenceVariantWidth,
      });
      world.resolver = resolver;
      const deps: EngineDeps = {
        cfg, processingFingerprint: fingerprint({ w: cfg.processing.widths, q: cfg.processing.quality }), configFingerprint: fingerprint(cfg),
        paths: { tempDir: path.join(dir, 'tmp'), journalDir: path.join(dir, 'journal'), reportDir: path.join(dir, 'reports') },
        journal: world.journal, source: storage, dest: storage, db, processor: new SharpProcessor({ threads: 1 }), cache, cdn: null, resolver,
        logger: new Logger({ level: 'error', stderr: false, journal: world.journal }), reporter: world.reporter, failpoints: world.failpoints, shutdown: world.shutdown,
        dryRun: false, mutationAuthorized: true, pid: world.nextPid++, host: 'testhost', isPidAlive: () => false, sleep: async () => undefined, rand: () => 0.5,
        timerMs: 0,
        ...o,
      };
      return new MigrationEngine(deps);
    },
    restart() {
      world.journal.close();
      world.journal = new SqliteJournal(journalFile);
      world.failpoints = new Failpoints();
      world.shutdown = new ShutdownController();
    },
    seedImage(key, buf, contentType = 'image/jpeg') {
      storage.seed(key, buf, contentType);
      return `https://${LEGACY_HOST}/${key}`;
    },
    url: (key, host = LEGACY_HOST) => `https://${host}/${key}`,
    cleanup() {
      try { world.journal.close(); } catch { /* closed */ }
      void db.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
  return world;
}

/** Seed a small realistic catalogue: n products each with photo, 2 gallery photos and a hover image (some shared). */
export async function seedCatalogue(w: World, n = 4): Promise<{ keys: string[] }> {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = `products/p${i}.jpg`;
    keys.push(k);
    w.storage.seed(k, await jpegFixture(600 + i * 10, 400, i), 'image/jpeg');
  }
  w.storage.seed('products/alpha.png', await pngFixture(500, 300, true), 'image/png');
  keys.push('products/alpha.png');
  for (let i = 0; i < n; i++) {
    w.db.insert('products', `prod${i}`, {
      name: `Product ${i}`, price: 100 + i, updatedAt: '2026-01-01T00:00:00.000Z',
      photo: w.url(`products/p${i}.jpg`),
      photos: [w.url(`products/p${i}.jpg`), w.url(`products/p${(i + 1) % n}.jpg`)],
      hoverImage: w.url('products/alpha.png', 'pub-abc.r2.dev'),
      tags: ['x'], customAttributes: { note: w.url(`products/p${i}.jpg`) /* not an approved field: must never change */ },
    });
  }
  w.db.insert('settings', 'site', {
    logoImage: 'https://images.pexels.com/photos/1/third-party.jpeg',
    homeSections: { categories: [{ title: 'a', image: w.url('products/p0.jpg') }, { title: 'b', image: 'https://ik.imagekit.io/x/y.jpg' }] },
  });
  return { keys };
}
