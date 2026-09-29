import { instructionSnapshot } from './agents.ts';
import { PreflightError, readContract } from './contract.ts';
import type { Evidence } from './evidence.ts';
import type { ExecutionInput } from './execution.ts';
import { runRepairImplementation } from './repair-implementation.ts';
import { verifyMutationEvidence, type ImplementationEvidence } from './mutation-evidence.ts';
import type { MergePreparation } from './merge-preparation.ts';
import type { TicketPlan } from './plan.ts';
import { digest } from './probe.ts';
import { Remote, type PullRequest } from './remote.ts';
import { commitRepair, pushRepair } from './repair-workspace.ts';
import { requireRemoteHead } from './ticket-workspace.ts';
import { git } from './process.ts';
import { isGateDefect, type GateBehaviorFailure, type ReviewBlocked } from './gate-defect.ts';

export interface RepairSubmission {
  number: number; ticket: TicketPlan; startedFrom: string; pr: PullRequest;
  ownedWorkspace: { cwd: string; resources: string; branch: string; expectedHead: string };
  implementationEvidence: ImplementationEvidence;
}
export interface TextConflictDefect { kind: 'text-conflict'; preparation: MergePreparation; evidence: Evidence; }
export type CandidateDefect = GateBehaviorFailure | ReviewBlocked | TextConflictDefect;
export type RepairOutcome = { kind: 'changed'; submission: RepairSubmission }
  | { kind: 'blocked' | 'no-progress'; reason: string; evidence: Evidence };
export function defectEvidence(defect: CandidateDefect): Evidence {
  return isGateDefect(defect) ? defect.binding.evidence : defect.evidence;
}

export async function repairCandidate(input: ExecutionInput, submitted: RepairSubmission, B: string, defect: CandidateDefect): Promise<RepairOutcome> {
  const { signal, ctx, contract, repository } = input;
  const H = submitted.pr.head.sha;
  const evidence = defectEvidence(defect);
  if (isGateDefect(defect) && (defect.binding.phase !== 'candidate' || defect.binding.versions.H !== H || defect.binding.versions.B !== B)) {
    throw new PreflightError('REPAIR_NOT_AUTHORIZED', 'Only a published failure for this current unmerged candidate may authorize repair');
  }
  const remote = new Remote(input.cwd, repository, signal);
  await input.scope.assert();
  await requireRemoteHead(input.cwd, input.feature, B);
  const before = await remote.pull(submitted.pr.number);
  if (before.merged || before.state !== 'open' || before.head.sha !== H || before.head.ref !== submitted.ownedWorkspace.branch || before.base.ref !== input.feature) {
    throw new PreflightError('REMOTE_DRIFT', 'Repair requires the same unique open PR and exact owned head');
  }
  const workspace = { ...submitted.ownedWorkspace, base: submitted.ownedWorkspace.expectedHead };
  if (workspace.base !== H) throw new PreflightError('WORKSPACE_DRIFT', 'Owned repair worktree and PR no longer share the same head');
  ctx.ui.notify(`REPAIR_STARTED: Ticket #${submitted.number} ${H} ${evidence.url}`, 'info');
  const { prepared, result } = await runRepairImplementation(input, submitted.number, workspace, B, prepared => JSON.stringify({ task: 'repair-candidate', spec: input.plan.spec, ticket: submitted.ticket,
    approvedChanges: [], scopeDigest: input.scopeDigest, startedFrom: submitted.startedFrom,
    H, B, failure: isGateDefect(defect) ? { behavior: 'report' in defect ? defect.report : undefined,
      review: defect.review, binding: defect.binding } : { kind: 'text-conflict', preparation: defect.preparation },
    failureEvidence: evidence, preparedTree: prepared.startTree, preparation: prepared.preparation,
    implementationEvidence: submitted.implementationEvidence,
    requirement: 'Repair only the concrete defect within the already approved requirements. Preserve all existing assertion identities and executable meaning. Do not change contracts, instructions, Spec or Ticket scope. For a text conflict, preserve both approved Ticket behaviors. If choosing a resolution needs a stakeholder decision, return blocked before editing. The controller alone appends to this same PR and reruns every gate; your summary is not approval.',
  }, null, 2), isGateDefect(defect) ? defect.binding.versions.C : undefined);
  if (digest(await readContract(workspace.cwd)) !== digest(contract)
    || digest(await instructionSnapshot(workspace.cwd, contract)) !== digest(input.approvedInstructions)) {
    throw new PreflightError('SCOPE_CHANGED', 'Repair changed approved commands or role instructions; no push authorized');
  }
  await input.scope.assert();
  await requireRemoteHead(input.cwd, input.feature, B);
  if (result.kind === 'blocked') {
    if (result.mutations.length || (await git(workspace.cwd, ['diff', '--name-only'], signal)).trim()) {
      throw new PreflightError('AGENT_RESULT_INVALID', 'Repair questions must be raised before modifying the prepared code');
    }
    const question = await remote.comment(submitted.number, `Repair decision needed for Ticket #${submitted.number}.\n\n${result.question}\n\n`
      + `Existing PR: ${before.html_url}\nHead: \`${H}\`\nScope: \`${input.scopeDigest}\`\nFailure evidence: ${evidence.url}\n\nNo interpretation has been approved; preserve this PR and its worktree.`);
    signal.throwIfAborted();
    ctx.ui.notify(`TICKET_BLOCKED: Ticket #${submitted.number} ${question.html_url}`, 'info');
    return { kind: 'blocked', reason: 'requirements-decision', evidence };
  }
  const committed = await commitRepair(prepared, submitted.number, result.mutations, submitted.implementationEvidence, signal);
  if (!committed) {
    ctx.ui.notify(`TICKET_NO_PROGRESS: #${submitted.number} no-code-change ${evidence.url}`, 'error');
    return { kind: 'no-progress', reason: 'no-code-change', evidence };
  }
  await verifyMutationEvidence(workspace.cwd, committed.proof, committed.head, committed.head, input.scopeDigest);
  if ((await git(workspace.cwd, ['status', '--porcelain'], signal)).trim()) throw new PreflightError('WORKSPACE_DRIFT', 'Repair commit did not leave the owned worktree clean');
  await input.scope.assert();
  await requireRemoteHead(input.cwd, input.feature, B);
  await pushRepair(workspace.cwd, workspace.branch, H, committed.head, signal);
  const current = await remote.pull(before.number);
  if (current.merged || current.state !== 'open' || current.head.sha !== committed.head || current.head.ref !== before.head.ref || current.base.ref !== before.base.ref) {
    throw new PreflightError('REMOTE_RESULT_UNKNOWN', 'Repair push and original PR do not confirm the same appended head; no replacement PR');
  }
  ctx.ui.notify(`TICKET_REPAIRED: #${submitted.number} ${H} ${committed.head} ${current.html_url}`, 'info');
  return { kind: 'changed', submission: { ...submitted, pr: current,
    ownedWorkspace: { ...submitted.ownedWorkspace, expectedHead: committed.head }, implementationEvidence: committed.proof } };
}
