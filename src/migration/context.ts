import type {
  CacheInvalidationProvider, CdnVerifier, DatabaseProvider, JournalStore, MediaProcessor, ProgressReporter, StorageProvider,
} from '../core/interfaces';
import type { Failpoints } from '../core/failpoints';
import type { ShutdownController } from '../core/shutdown';
import type { MediaMigrateConfig } from '../config/schema';
import type { MediaUrlResolver } from '../compatibility/resolver';
import type { Logger } from '../observability/logger';

export interface EnginePaths {
  tempDir: string;
  journalDir: string;
  reportDir: string;
}

export interface EngineDeps {
  cfg: MediaMigrateConfig;
  processingFingerprint: string;
  configFingerprint: string;
  paths: EnginePaths;
  journal: JournalStore;
  source: StorageProvider;
  dest: StorageProvider;
  db: DatabaseProvider;
  processor: MediaProcessor;
  cache: CacheInvalidationProvider;
  cdn?: CdnVerifier | null;
  resolver: MediaUrlResolver;
  logger: Logger;
  reporter: ProgressReporter;
  failpoints?: Failpoints;
  shutdown?: ShutdownController;
  /** When true every provider is wrapped read-only inside the engine (not just in the CLI). */
  dryRun: boolean;
  /** Safety gate result for non-dry-run mutation (checked by the engine itself). */
  mutationAuthorized?: boolean;
  pid?: number;
  host?: string;
  isPidAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  clock?: () => Date;
  /** Periodic heartbeat/checkpoint timer interval; 0 disables the timer (ticks still happen per asset). */
  timerMs?: number;
}

export interface RunOptions {
  runId?: string;
  resume?: boolean;
  limit?: number;
  since?: Date;
  until?: Date;
  concurrency?: number;
  batchSize?: number;
  /** Restrict to these assets (used by `retry`). */
  assetIds?: readonly string[];
  /** Skip the DB inventory scan and work from the journal only (used by retry/resume of process stage). */
  skipInventory?: boolean;
  /** Allow resuming under a different config fingerprint (dangerous). */
  allowConfigChange?: boolean;
}

export type RunKindForEngine = 'inventory' | 'dry-run' | 'process' | 'migrate';

export interface RunResult {
  runId: string;
  status: 'COMPLETE' | 'INCOMPLETE' | 'FAILED' | 'INTERRUPTED' | 'DRY_RUN_COMPLETE';
  exitCode: number;
  message: string;
  summary: Record<string, unknown>;
}

export interface InventoryStats {
  docsScanned: number;
  refsSeen: number;
  legacy: number;
  canonical: number;
  excluded: number;
  invalid: number;
  external: Record<string, number>;
  newAssets: number;
  reopened: number;
  byCollection: Record<string, number>;
}

export const emptyStats = (): InventoryStats => ({
  docsScanned: 0, refsSeen: 0, legacy: 0, canonical: 0, excluded: 0, invalid: 0, external: {}, newAssets: 0, reopened: 0, byCollection: {},
});
