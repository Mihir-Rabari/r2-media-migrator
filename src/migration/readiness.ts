import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JournalStore } from '../core/interfaces';

export interface Attestations {
  configFingerprint: string;
  automatedTestsPassed?: boolean;
  testedCommit?: string;
  rollbackTested?: boolean;
  compatibilityTested?: boolean;
  mappingReviewed?: boolean;
  sampleReviewApproved?: boolean;
  authorizedBy?: string;
  authorizedAt?: string;
}

export interface Gate {
  id: string;
  title: string;
  status: 'PASS' | 'BLOCKED';
  kind: 'automatic' | 'attestation';
  detail: string;
}

export interface ReadinessReport {
  ready: boolean;
  gates: Gate[];
}

export const attestationFile = (journalDir: string): string => path.join(journalDir, 'readiness.json');

export function readAttestations(journalDir: string): Attestations | null {
  try {
    return JSON.parse(fs.readFileSync(attestationFile(journalDir), 'utf8'));
  } catch {
    return null;
  }
}

export function writeAttestations(journalDir: string, a: Attestations): void {
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(attestationFile(journalDir), JSON.stringify(a, null, 2));
}

/**
 * Production-readiness gates. Automatic gates are computed from journal evidence; attestation gates require a
 * human to state (and be named for) things this tool cannot observe. Attestations are bound to the config
 * fingerprint: editing the config invalidates them. Nothing here ever flips on its own.
 */
export function evaluateReadiness(journal: JournalStore, configFingerprint: string, journalDir: string, sampleTarget = 20): ReadinessReport {
  const gates: Gate[] = [];
  const g = (id: string, title: string, ok: boolean, kind: Gate['kind'], detail: string) => gates.push({ id, title, status: ok ? 'PASS' : 'BLOCKED', kind, detail });
  const runs = journal.listRuns(500);
  const sameCfg = runs.filter((r) => r.configFingerprint === configFingerprint);

  g('config', 'Configuration validates', true, 'automatic', 'validated on load');

  const fullInv = sameCfg.find((r) => journal.latest(r.runId, 'inventory:complete') && !(r.params as { since?: string; until?: string }).since && !(r.params as { until?: string }).until);
  g('inventory', 'Inventory complete (full scope, current config)', !!fullInv, 'automatic', fullInv ? `run ${fullInv.runId}` : 'no complete, unscoped inventory for this configuration; run `inventory`');

  const byState = journal.countByState();
  const total = Object.values(byState).reduce((a, b) => a + b, 0);
  const verifiedN = (['DESTINATION_VERIFIED', 'REFERENCES_UPDATED', 'CACHE_HANDLED', 'COMPLETE'] as const).reduce((a, s) => a + (byState[s] ?? 0), 0);
  const planned = total - (byState.SKIPPED ?? 0) - (byState.SOURCE_MISSING ?? 0);

  const dry = sameCfg.find((r) => r.status === 'DRY_RUN_COMPLETE' && r.kind === 'dry-run');
  let dryOk = false;
  let dryDetail = 'no completed dry run for this configuration; run `dry-run`';
  if (dry) {
    const evs = journal.events(dry.runId, { limit: 100000 });
    const ok = evs.filter((e) => e.type === 'dryrun.asset').length;
    const errs = evs.filter((e) => e.type === 'dryrun.asset-error').length;
    dryOk = errs === 0 && ok >= Math.min(sampleTarget, Math.max(planned, 1));
    dryDetail = `run ${dry.runId}: ${ok} sampled, ${errs} sample error(s)`;
  }
  g('dry-run', 'Dry run completed with error-free samples', dryOk, 'automatic', dryDetail);

  const sampleVerified = verifiedN >= Math.min(sampleTarget, Math.max(planned, 1)) && verifiedN > 0;
  g('destination', 'Destination uploads verified (checksums) for a sample', sampleVerified, 'automatic', `${verifiedN} asset(s) verified at destination (need ${Math.min(sampleTarget, Math.max(planned, 1))}); run \`process --limit ${sampleTarget} --yes\``);

  const integ = journal.integrityCheck();
  g('journal', 'Journal integrity check (incl. I1)', integ.ok, 'automatic', integ.ok ? 'ok' : integ.messages.join('; '));

  const unresolved = (byState.FAILED ?? 0) + (byState.CONFLICT ?? 0) + (byState.RECONCILE_REQUIRED ?? 0);
  g('no-open-problems', 'No failed / conflicting / reconcile-required assets', unresolved === 0, 'automatic', `${unresolved} open`);

  const att = readAttestations(journalDir);
  const valid = !!att && att.configFingerprint === configFingerprint;
  const a = valid ? att! : ({} as Attestations);
  const note = !att ? 'no attestation file' : valid ? '' : 'attestation was made for a different configuration';
  g('samples-reviewed', 'Representative samples visually reviewed and approved by a human', !!a.sampleReviewApproved, 'attestation', note || 'attest "samples"');
  g('mapping-reviewed', 'Database field mappings reviewed (media-reference-map.md)', !!a.mappingReviewed, 'attestation', note || 'attest "mapping"');
  g('compat', 'Compatibility behaviour tested (resolver / HTTP handler / frontend)', !!a.compatibilityTested, 'attestation', note || 'attest "compat"');
  g('rollback', 'Rollback and recovery tested (staging)', !!a.rollbackTested, 'attestation', note || 'attest "rollback"');
  g('tests', 'Mandatory automated tests pass', !!a.automatedTestsPassed, 'attestation', note || (a.testedCommit ? `at ${a.testedCommit}` : 'attest "tests"'));
  g('authorization', 'Operator explicitly authorises the production run', !!a.authorizedBy && !!a.authorizedAt, 'attestation', note || (a.authorizedBy ? `by ${a.authorizedBy}` : 'attest "authorize" with --authorized-by NAME'));

  return { ready: gates.every((x) => x.status === 'PASS'), gates };
}
