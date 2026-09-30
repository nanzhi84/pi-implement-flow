import { PreflightError } from './contract.ts';
import type { ReportedBehavior } from './command-outcome.ts';
import type { Evidence } from './evidence.ts';
import type { Versions } from './gate.ts';
import type { FailureObservation, PriorBlocker, AssertionFact } from './repair-progress.ts';
import type { ReviewResult } from './review.ts';

export interface PublishedDefect {
  evidence: Evidence; phase: 'candidate' | 'actual'; codeSha: string; versions: Versions;
  scopeDigest: string; contractDigest: string; instructionsDigest: string;
  observation: FailureObservation;
}
export class GateBehaviorFailure extends PreflightError {
  constructor(readonly report: ReportedBehavior, readonly binding: PublishedDefect, readonly review: ReviewResult) {
    super('GATE_BEHAVIOR_FAILED', 'Executable behavior failed after safe cleanup and verified failure publication; this is evidence, not integration approval');
  }
}
export class ReviewBlocked extends PreflightError {
  constructor(readonly review: ReviewResult, readonly binding: PublishedDefect) {
    super('REVIEW_BLOCKED', 'Independent review found blocking defects; implementation statements cannot authorize integration');
  }
}
export interface GateRepairContext { previousBlockers: PriorBlocker[]; previousAssertions?: AssertionFact[]; }
export function isGateDefect(error: unknown): error is GateBehaviorFailure | ReviewBlocked {
  return error instanceof GateBehaviorFailure || error instanceof ReviewBlocked;
}
