import { PreflightError } from './contract.ts';
import type { ExecutionInput } from './execution.ts';
import { ticketGate, type GateEvidence, type Versions } from './gate.ts';
import { isGateDefect } from './gate-defect.ts';
import { GitHub } from './github.ts';
import { canonicalMerge } from './merge-preparation.ts';
import { publishConflict } from './conflict-evidence.ts';
import { Remote, type PullRequest } from './remote.ts';
import { repairCandidate, defectEvidence, type CandidateDefect, type RepairSubmission } from './repair.ts';
import { RepairProgress, remainingBlockers, type PriorBlocker, type AssertionFact } from './repair-progress.ts';
import { reviewBlockerComment } from './review.ts';
import { requireRemoteHead } from './ticket-workspace.ts';
import { commitParents } from './code-proof.ts';
import { git } from './process.ts';
import type { Evidence } from './evidence.ts';

export class TicketPaused extends PreflightError {
  constructor(readonly ticket: number, readonly reason: 'requirements-decision' | 'no-code-change' | 'no-progress' | 'progress-unverified', readonly evidence: Evidence) {
    super(reason === 'requirements-decision' ? 'REPAIR_BLOCKED' : 'NO_PROGRESS', 'Candidate repair paused with existing PR and verified failure evidence preserved; no integration authority');
  }
}
export function expectedPull(pr: PullRequest, input: ExecutionInput, submission: RepairSubmission) {
  if (pr.head.ref !== submission.ownedWorkspace.branch || pr.base.ref !== input.feature || pr.head.sha !== submission.pr.head.sha) {
    throw new PreflightError('EVIDENCE_STALE', 'Ticket PR identity or head changed; prior evidence cannot authorize this version');
  }
}
export async function reviewedCandidate(input: ExecutionInput, initial: RepairSubmission, B: string): Promise<{
  submission: RepairSubmission; before: PullRequest; versions: Versions; candidate: GateEvidence; previousBlockers: PriorBlocker[];
}> {
  const { cwd, signal, ctx } = input;
  const remote = new Remote(cwd, input.repository, signal);
  const github = await GitHub.fromOrigin(cwd);
  let submission = initial;
  let previousBlockers: PriorBlocker[] = [];
  let previousAssertions: AssertionFact[] = [];
  const progress = new RepairProgress();
  while (true) {
    signal.throwIfAborted(); await input.assertScope(); await requireRemoteHead(cwd, input.feature, B);
    await github.inspectProtection(input.feature); await remote.requireMergeStrategy();
    const before = await remote.pull(submission.pr.number);
    expectedPull(before, input, submission);
    if (before.merged || before.state !== 'open' || before.base.sha !== B) throw new PreflightError('CANDIDATE_UNAVAILABLE', 'Repair candidate must remain an open PR at the accepted base');
    const H = before.head.sha;
    let defect: CandidateDefect;
    if (!before.merge_commit_sha) {
      const preparation = await canonicalMerge(cwd, H, B, signal);
      if (!preparation.conflicts.length) throw new PreflightError('CANDIDATE_UNAVAILABLE', 'GitHub has not provided the actual merge candidate; no guessed commit may authorize a gate');
      defect = await publishConflict(input, submission, preparation);
    } else {
      const C = before.merge_commit_sha;
      await git(cwd, ['fetch', '--no-write-fetch-head', 'origin', C], signal);
      if (JSON.stringify(await commitParents(cwd, C)) !== JSON.stringify([B, H])) throw new PreflightError('EVIDENCE_STALE', 'GitHub candidate has different ordered parents');
      const versions: Versions = { H, B, C };
      try {
        const candidate = await ticketGate(input, submission.ticket, versions, 'candidate', submission.implementationEvidence, { previousBlockers, previousAssertions });
        return { submission, before, versions, candidate, previousBlockers };
      } catch (error) {
        if (!isGateDefect(error) || error.binding.phase !== 'candidate') throw error;
        defect = error;
      }
    }
    const evidence = defectEvidence(defect);
    let body = `Candidate failure for Ticket #${submission.number}.\n\nHead: \`${H}\`\nBase: \`${B}\`\nScope: \`${input.scopeDigest}\`\n`
      + `Verified failure evidence: ${evidence.url}\nSHA256: \`${evidence.sha256}\`\n\nNo integration or closure is authorized by this failure report.`;
    if (isGateDefect(defect) && (defect.review.blockers.length || defect.review.resolutions?.some(item => item.status === 'unresolved'))) {
      body += '\n\n' + reviewBlockerComment(submission.number, 'candidate', defect.review);
    }
    if (Buffer.byteLength(body, 'utf8') > 60_000) throw new PreflightError('EVIDENCE_CAPACITY', 'Complete failure index does not fit the remote comment contract; no truncation or repair');
    const comment = await remote.comment(before.number, body);
    ctx.ui.notify(`REVIEW_FINDINGS: candidate ${evidence.codeSha} ${comment.html_url}`, 'error');
    await input.assertScope(); await requireRemoteHead(cwd, input.feature, B);
    const current = await remote.pull(before.number); expectedPull(current, input, submission);
    if (current.merged || current.state !== 'open') throw new PreflightError('REMOTE_DRIFT', 'PR changed after failure publication; no repair');
    if (isGateDefect(defect)) {
      const decision = await progress.observe(cwd, defect.binding.observation);
      previousBlockers = remainingBlockers(defect.binding.observation);
      previousAssertions = defect.binding.observation.assertions;
      if (decision === 'no-progress' || decision === 'progress-unverified') {
        ctx.ui.notify(`TICKET_NO_PROGRESS: #${submission.number} ${decision} ${evidence.url}`, 'error');
        throw new TicketPaused(submission.number, decision, evidence);
      }
    }
    const outcome = await repairCandidate(input, submission, B, defect);
    if (outcome.kind !== 'changed') throw new TicketPaused(submission.number, outcome.reason as 'requirements-decision' | 'no-code-change', evidence);
    submission = outcome.submission;
  }
}
