import { PreflightError } from './contract.ts';
import { blob, treeOf } from './code-proof.ts';
import type { ReviewBlocker, ReviewResult } from './review.ts';

export interface AssertionFact { command: 'check' | 'accept'; name: string; passed: boolean; }
export interface PriorBlocker { ref: string; codeSha: string; blocker: ReviewBlocker; assertions: AssertionFact[]; }
export type ResolutionEvidence = { command: 'check' | 'accept'; name: string } | { path: string; blobSha256: string };
export interface ReviewResolution { ref: string; status: 'resolved' | 'unresolved'; basis: string; evidence: ResolutionEvidence[]; }
export interface FailureObservation {
  codeSha: string; B: string; scopeDigest: string; contractDigest: string; instructionsDigest: string;
  evidenceSha256: string; assertions: AssertionFact[]; review: ReviewResult; previousBlockers: PriorBlocker[];
}

export function remainingBlockers(observation: FailureObservation): PriorBlocker[] {
  const unresolved = observation.previousBlockers.filter(old => observation.review.resolutions?.find(item => item.ref === old.ref)?.status !== 'resolved');
  return [...unresolved, ...observation.review.blockers.map((blocker, index) => ({
    ref: `${observation.evidenceSha256}:${index}`, codeSha: observation.codeSha, blocker, assertions: observation.assertions,
  }))];
}
export async function verifyResolutions(cwd: string, codeSha: string, previous: PriorBlocker[], review: ReviewResult, assertions: AssertionFact[]) {
  const resolutions = review.resolutions ?? [];
  if (resolutions.length !== previous.length || new Set(resolutions.map(item => item.ref)).size !== previous.length) {
    throw new PreflightError('REVIEW_PROGRESS_INVALID', 'Independent review must explicitly resolve every prior stable blocker reference');
  }
  for (const resolution of resolutions) {
    const old = previous.find(item => item.ref === resolution.ref);
    if (!old) throw new PreflightError('REVIEW_PROGRESS_INVALID', 'Review refers to an unknown prior blocker');
    if (resolution.status === 'unresolved') continue;
    if (!resolution.evidence.length) throw new PreflightError('REVIEW_PROGRESS_INVALID', 'Resolved blockers require independently verifiable changed evidence');
    for (const fact of resolution.evidence) {
      let valid = false;
      if ('command' in fact) {
        valid = assertions.some(item => item.command === fact.command && item.name === fact.name && item.passed)
          && old.assertions.some(item => item.command === fact.command && item.name === fact.name && !item.passed);
      } else {
        const current = await blob(cwd, codeSha, fact.path); const original = await blob(cwd, old.codeSha, fact.path);
        valid = !!current && current.hash === fact.blobSha256 && current.hash !== original?.hash;
      }
      if (!valid) throw new PreflightError('REVIEW_PROGRESS_INVALID', 'Claimed blocker resolution is not bound to a changed current blob or observed false-to-true assertion');
    }
  }
}

// A run-local set records observed states, never attempts, budgets or recovery.
export class RepairProgress {
  private readonly observed = new Set<string>();
  private previous?: FailureObservation;
  async observe(cwd: string, next: FailureObservation): Promise<'first' | 'progress' | 'no-progress' | 'progress-unverified'> {
    const tree = await treeOf(cwd, next.codeSha);
    const frontier = remainingBlockers(next).map(item => item.ref).sort();
    const failures = next.assertions.filter(item => !item.passed).map(item => `${item.command}:${item.name}`).sort();
    const key = JSON.stringify([next.B, next.scopeDigest, next.contractDigest, next.instructionsDigest, tree, failures, frontier]);
    const repeated = this.observed.has(key); this.observed.add(key);
    const old = this.previous; this.previous = next;
    if (!old) return 'first';
    if (repeated) return 'no-progress';
    if (old.B !== next.B || old.scopeDigest !== next.scopeDigest || old.contractDigest !== next.contractDigest
      || old.instructionsDigest !== next.instructionsDigest) return 'progress-unverified';
    let resolved = false;
    for (const assertion of old.assertions) {
      const current = next.assertions.find(item => item.command === assertion.command && item.name === assertion.name);
      if (!current || (assertion.passed && !current.passed)) return 'progress-unverified';
      if (!assertion.passed && current.passed) resolved = true;
    }
    const oldRefs = remainingBlockers(old).map(item => item.ref);
    if (oldRefs.some(ref => next.review.resolutions?.find(item => item.ref === ref)?.status === 'resolved')) resolved = true;
    return resolved ? 'progress' : 'no-progress';
  }
}
