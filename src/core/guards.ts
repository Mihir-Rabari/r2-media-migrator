import { DryRunViolation } from '../domain/errors';
import type { CacheInvalidationProvider, DatabaseProvider, StorageProvider } from './interfaces';

/**
 * Dry-run enforcement BELOW the CLI. Wrapping a provider makes every mutating method throw, so a
 * missing `if (dryRun)` check in a command or in the engine cannot mutate production (invariant I2).
 */
export class MutationLedger {
  readonly blocked: string[] = [];
  record(op: string): never {
    this.blocked.push(op);
    throw new DryRunViolation(op);
  }
}

export function readOnlyStorage(inner: StorageProvider, ledger = new MutationLedger()): StorageProvider {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'put' || prop === 'delete') return () => ledger.record(`storage.${String(prop)}`);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export function readOnlyDatabase(inner: DatabaseProvider, ledger = new MutationLedger()): DatabaseProvider {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'compareAndSet') return () => ledger.record('database.compareAndSet');
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export function readOnlyCache(inner: CacheInvalidationProvider, ledger = new MutationLedger()): CacheInvalidationProvider {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'purge') return () => ledger.record('cache.purge');
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
