import { MediaMigrateError, SimulatedCrash } from '../domain/errors';

/**
 * Deterministic fault injection. Failpoints are no-ops unless explicitly armed, and the env-var
 * route additionally requires MEDIA_MIGRATE_ENABLE_FAILPOINTS=1 so production can never arm them by accident.
 *
 * Modes:
 *  - crash: throw SimulatedCrash (in-process tests: the "process" dies, state must be recoverable)
 *  - error: throw a transient MediaMigrateError (a provider hiccup; retry budget applies)
 *  - exit : process.exit(86) immediately, no cleanup (CLI end-to-end tests)
 */
export type FailMode = 'crash' | 'error' | 'exit' | 'sleep';

export interface FailArm {
  mode: FailMode;
  /** Let this many hits pass first. */
  after?: number;
  /** Fire at most this many times (default 1). */
  times?: number;
  /** For mode=sleep: pause this long (lets end-to-end tests hold a lock or a run open deterministically). */
  ms?: number;
}

export const EXIT_CODE_FAILPOINT = 86;

/** Every failpoint the engine exposes. Tests iterate this list. */
export const FAILPOINT_NAMES = [
  'download:before', 'download:after',
  'process:after',
  'upload:before', 'upload:after',
  'verify:before', 'verify:after',
  'transition:before:PROCESSING', 'transition:after:PROCESSING',
  'transition:before:ASSETS_WRITTEN', 'transition:after:ASSETS_WRITTEN',
  'transition:before:DESTINATION_VERIFIED', 'transition:after:DESTINATION_VERIFIED',
  'db:before-intent', 'db:after-intent', 'db:before-write', 'db:after-write',
  'transition:before:REFERENCES_UPDATED', 'transition:after:REFERENCES_UPDATED',
  'cache:before', 'cache:after',
  'transition:before:CACHE_HANDLED', 'transition:after:CACHE_HANDLED',
  'transition:before:COMPLETE', 'transition:after:COMPLETE',
] as const;
export type FailpointName = (typeof FAILPOINT_NAMES)[number];

export class Failpoints {
  private arms = new Map<string, FailArm & { hits: number; fired: number }>();
  private hooks = new Map<string, Array<(hit: number) => void | Promise<void>>>();
  private counts = new Map<string, number>();
  readonly history: string[] = [];

  arm(name: string, arm: FailArm): this {
    this.arms.set(name, { ...arm, hits: 0, fired: 0 });
    return this;
  }
  disarmAll(): void {
    this.arms.clear();
    this.hooks.clear();
  }
  /** Run a callback every time a failpoint is reached (deterministic concurrent-edit simulation). */
  on(name: string, fn: (hit: number) => void | Promise<void>): this {
    this.hooks.set(name, [...(this.hooks.get(name) ?? []), fn]);
    return this;
  }
  /** How many times each failpoint was reached. */
  hitCount(name: string): number {
    return this.counts.get(name) ?? 0;
  }
  get armed(): boolean {
    return this.arms.size > 0 || this.hooks.size > 0;
  }

  /** Parse `name[=mode][@after]` comma list. */
  static fromEnv(env: NodeJS.ProcessEnv): Failpoints {
    const fp = new Failpoints();
    const raw = env.MEDIA_MIGRATE_FAILPOINTS;
    if (!raw || env.MEDIA_MIGRATE_ENABLE_FAILPOINTS !== '1') return fp;
    for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = /^([^=@]+)(?:=(crash|error|exit|sleep)(?::(\d+))?)?(?:@(\d+))?$/.exec(part);
      if (!m) continue;
      fp.arm(m[1], { mode: (m[2] as FailMode) ?? 'crash', ms: m[3] ? Number(m[3]) : undefined, after: m[4] ? Number(m[4]) : 0 });
    }
    return fp;
  }

  async hit(name: string): Promise<void> {
    const n = (this.counts.get(name) ?? 0) + 1;
    this.counts.set(name, n);
    for (const h of this.hooks.get(name) ?? []) await h(n);
    const a = this.arms.get(name);
    if (!a) return;
    a.hits++;
    if (a.hits <= (a.after ?? 0)) return;
    if (a.fired >= (a.times ?? 1)) return;
    a.fired++;
    this.history.push(name);
    if (a.mode === 'exit') process.exit(EXIT_CODE_FAILPOINT);
    if (a.mode === 'sleep') {
      await new Promise((r) => setTimeout(r, a.ms ?? 1000));
      return;
    }
    if (a.mode === 'error') throw new MediaMigrateError('transient', 'FAILPOINT', `injected transient failure at ${name}`);
    throw new SimulatedCrash(name);
  }
}

export const NO_FAILPOINTS = new Failpoints();
