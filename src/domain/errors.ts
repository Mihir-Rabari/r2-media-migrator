/** Error taxonomy, exit codes and retry classification. */

export const ExitCode = {
  OK: 0,
  OPERATIONAL: 1,
  VALIDATION: 2,
  INTERRUPTED: 3,
  INCOMPLETE: 4,
  VERIFICATION_INCOMPLETE: 5,
  ROLLBACK_FAILED: 6,
  LOCKED: 7,
  BLOCKED: 8,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorKind =
  | 'validation' // bad config/arguments: nothing was mutated
  | 'transient' // retry may help
  | 'permanent' // retry will not help (corrupt image, 403, ...)
  | 'conflict' // concurrent modification detected
  | 'safety' // blocked by a safety gate / dry-run guard
  | 'locked'
  | 'not-found'
  | 'integrity' // checksum/size mismatch
  | 'internal';

export class MediaMigrateError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly detail?: Record<string, unknown>;
  constructor(kind: ErrorKind, code: string, message: string, detail?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MediaMigrateError';
    this.kind = kind;
    this.code = code;
    this.detail = detail;
  }
  get exitCode(): ExitCodeValue {
    switch (this.kind) {
      case 'validation':
        return ExitCode.VALIDATION;
      case 'locked':
        return ExitCode.LOCKED;
      case 'safety':
        return ExitCode.BLOCKED;
      default:
        return ExitCode.OPERATIONAL;
    }
  }
}

export const validationError = (code: string, message: string, detail?: Record<string, unknown>) =>
  new MediaMigrateError('validation', code, message, detail);
export const safetyError = (code: string, message: string, detail?: Record<string, unknown>) =>
  new MediaMigrateError('safety', code, message, detail);

/** Thrown only by dry-run guards. */
export class DryRunViolation extends MediaMigrateError {
  constructor(operation: string) {
    super('safety', 'DRY_RUN_VIOLATION', `dry-run: refusing mutating operation "${operation}"`, { operation });
    this.name = 'DryRunViolation';
  }
}

/** Thrown by failpoints to simulate a process crash. The engine must never catch-and-continue on it. */
export class SimulatedCrash extends Error {
  readonly failpoint: string;
  constructor(failpoint: string) {
    super(`simulated crash at failpoint "${failpoint}"`);
    this.name = 'SimulatedCrash';
    this.failpoint = failpoint;
  }
}

export class IntegrityError extends MediaMigrateError {
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super('integrity', code, message, detail);
    this.name = 'IntegrityError';
  }
}

const TRANSIENT_NODE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EBUSY', 'ESOCKETTIMEDOUT', 'UND_ERR_SOCKET',
]);
const TRANSIENT_AWS_NAMES = new Set([
  'Throttling', 'ThrottlingException', 'SlowDown', 'RequestTimeout', 'RequestTimeoutException', 'TimeoutError',
  'InternalError', 'ServiceUnavailable', 'RequestLimitExceeded', 'TooManyRequestsException', 'NetworkingError',
]);

/** Classify any thrown value as retryable or not. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof SimulatedCrash) return false;
  if (err instanceof MediaMigrateError) return err.kind === 'transient';
  const e = err as { code?: string; name?: string; $metadata?: { httpStatusCode?: number }; $retryable?: unknown; status?: number };
  if (!e || typeof e !== 'object') return false;
  const status = e.$metadata?.httpStatusCode ?? e.status;
  if (typeof status === 'number') return status === 429 || status === 408 || status >= 500;
  if (e.code && TRANSIENT_NODE_CODES.has(e.code)) return true;
  if (e.name && TRANSIENT_AWS_NAMES.has(e.name)) return true;
  return false;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
