import { AssetState, RefStatus } from './types';
import { MediaMigrateError } from './errors';

/**
 * Legal asset transitions. Anything not listed is a programming error and throws.
 * Happy path: DISCOVERED -> PLANNED -> PROCESSING -> ASSETS_WRITTEN -> DESTINATION_VERIFIED
 *             -> REFERENCES_UPDATED -> CACHE_HANDLED -> COMPLETE
 */
export const ASSET_TRANSITIONS: Readonly<Record<AssetState, readonly AssetState[]>> = {
  DISCOVERED: ['PLANNED', 'SKIPPED', 'SOURCE_MISSING', 'FAILED'],
  PLANNED: ['PROCESSING', 'SKIPPED', 'SOURCE_MISSING', 'FAILED'],
  PROCESSING: ['ASSETS_WRITTEN', 'FAILED', 'SOURCE_MISSING', 'SKIPPED', 'CONFLICT'],
  // verification mismatch sends the item back to PROCESSING (regenerate); never forward.
  ASSETS_WRITTEN: ['DESTINATION_VERIFIED', 'PROCESSING', 'FAILED'],
  DESTINATION_VERIFIED: ['REFERENCES_UPDATED', 'COMPLETE', 'FAILED', 'CONFLICT', 'ROLLED_BACK', 'RECONCILE_REQUIRED'],
  REFERENCES_UPDATED: ['CACHE_HANDLED', 'FAILED', 'CONFLICT', 'ROLLED_BACK', 'RECONCILE_REQUIRED'],
  CACHE_HANDLED: ['COMPLETE', 'FAILED', 'ROLLED_BACK', 'RECONCILE_REQUIRED'],
  COMPLETE: ['ROLLED_BACK', 'RECONCILE_REQUIRED'],
  FAILED: ['PLANNED', 'RECONCILE_REQUIRED', 'ROLLED_BACK'],
  SKIPPED: ['PLANNED'],
  SOURCE_MISSING: ['PLANNED'],
  CONFLICT: ['PLANNED', 'ROLLED_BACK', 'RECONCILE_REQUIRED'],
  ROLLED_BACK: ['PLANNED'],
  RECONCILE_REQUIRED: ['PLANNED', 'DESTINATION_VERIFIED', 'REFERENCES_UPDATED', 'COMPLETE', 'ROLLED_BACK', 'FAILED'],
};

export const TERMINAL_OK_STATES: ReadonlySet<AssetState> = new Set(['COMPLETE']);
/** States that never block a run from being COMPLETE (policy decisions, not failures). */
export const NEUTRAL_STATES: ReadonlySet<AssetState> = new Set(['SKIPPED']);

export function canTransition(from: AssetState, to: AssetState): boolean {
  return ASSET_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: AssetState, to: AssetState): void {
  if (!canTransition(from, to)) {
    throw new MediaMigrateError('internal', 'ILLEGAL_TRANSITION', `illegal asset transition ${from} -> ${to}`, { from, to });
  }
}

/** Forward order used for resume decisions. */
export const FORWARD_ORDER: readonly AssetState[] = [
  'DISCOVERED', 'PLANNED', 'PROCESSING', 'ASSETS_WRITTEN', 'DESTINATION_VERIFIED', 'REFERENCES_UPDATED', 'CACHE_HANDLED', 'COMPLETE',
];

export const REF_TRANSITIONS: Readonly<Record<RefStatus, readonly RefStatus[]>> = {
  PENDING: ['UPDATING', 'CONFLICT', 'UPDATED'],
  UPDATING: ['UPDATED', 'PENDING', 'CONFLICT'],
  UPDATED: ['ROLLED_BACK', 'ROLLBACK_CONFLICT'],
  CONFLICT: ['PENDING'],
  ROLLED_BACK: ['PENDING'],
  ROLLBACK_CONFLICT: ['ROLLED_BACK', 'UPDATED'],
};

export function assertRefTransition(from: RefStatus, to: RefStatus): void {
  if (from === to) return;
  if (!REF_TRANSITIONS[from]?.includes(to)) {
    throw new MediaMigrateError('internal', 'ILLEGAL_REF_TRANSITION', `illegal reference transition ${from} -> ${to}`, { from, to });
  }
}
