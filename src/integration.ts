import { PreflightError } from './contract.ts';
import { ensureDraftTotal, type ExecutionInput, type TicketResult } from './execution.ts';
import { ticketGate, ReviewBlocked, type GateEvidence, type Versions } from './gate.ts';
import { GitHub } from './github.ts';
import { Remote, type PullRequest } from './remote.ts';
import { git } from './process.ts';
import { requireRemoteHead, remoteHead } from './ticket-workspace.ts';

export interface IntegrationFacts {
  ticket: number; M: string; phase: 'merged-unaccepted' | 'closure-pending' | 'closed-unaccepted' | 'delivered';
}
async function parents(cwd: string, sha: string) {
  return (await git(cwd, ['show', '-s', '--format=%P', sha])).trim().split(' ');
}
async function tree(cwd: string, sha: string) { return (await git(cwd, ['rev-parse', `${sha}^{tree}`])).trim(); }
function expectedPull(pr: PullRequest, input: ExecutionInput, ticket: number, H: string) {
  if (pr.head.ref !== `flow/ticket-${input.plan.spec.number}-${ticket}` || pr.base.ref !== input.feature || pr.head.sha !== H) {
    throw new PreflightError('EVIDENCE_STALE', 'Ticket PR identity or head changed; previous candidate evidence cannot authorize the new version');
  }
}
function evidenceText(evidence: GateEvidence) {
  return `- ${evidence.phase}: \`${evidence.codeSha}\` — ${evidence.url}\n  SHA256: \`${evidence.sha256}\``;
}

export async function integrateTicket(input: ExecutionInput, submitted: TicketResult,
  onFacts: (facts: IntegrationFacts) => void): Promise<TicketResult> {
  if (!submitted.pr) throw new PreflightError('PR_REQUIRED', 'A Ticket PR is required before integration');
  const ticket = input.plan.tickets.find(item => item.issue.number === submitted.number);
  if (!ticket) throw new PreflightError('PLAN_INVALID', 'Submitted Ticket is outside the approved plan');
  const { cwd, signal, ctx } = input;
  const remote = new Remote(cwd, input.repository, signal);
  const github = await GitHub.fromOrigin(cwd);
  const H = submitted.pr.head.sha;
  const B = await remoteHead(cwd, input.feature);
  if (!B || B !== input.base) throw new PreflightError('REMOTE_DRIFT', 'Feature changed outside this single-Ticket controller; preserve work and reconcile');
  await input.assertScope();
  await github.inspectProtection(input.feature);
  await remote.requireMergeStrategy();
  const before = await remote.pull(submitted.pr.number);
  expectedPull(before, input, ticket.issue.number, H);
  if (before.merged || before.state !== 'open' || before.base.sha !== B || !before.merge_commit_sha) {
    throw new PreflightError('CANDIDATE_UNAVAILABLE', 'A current open PR with a verifiable GitHub merge candidate is required; no retry or guessed candidate');
  }
  const C = before.merge_commit_sha;
  // Fetch the exact remote object, never use mutable FETCH_HEAD as the identity.
  await git(cwd, ['fetch', '--no-write-fetch-head', 'origin', C], signal);
  if (JSON.stringify(await parents(cwd, C)) !== JSON.stringify([B, H])) {
    throw new PreflightError('EVIDENCE_STALE', 'GitHub merge candidate does not have the current ordered base/head parents');
  }
  const versions: Versions = { H, B, C };
  const reviewedGate = async (current: Versions, phase: 'candidate' | 'actual') => {
    try { return await ticketGate(input, ticket, current, phase, submitted.implementationEvidence); }
    catch (error) {
      if (error instanceof ReviewBlocked && !signal.aborted) {
        const codeSha = phase === 'candidate' ? current.C : current.M!;
        const findings = await remote.comment(before.number, `Independent review blocked Ticket #${ticket.issue.number}.\n\n`
          + `Phase: \`${phase}\`\nVersion: \`${codeSha}\`\nScope: \`${input.scopeDigest}\`\n\n`
          + error.review.blockers.map(finding => `- ${finding.category}: ${finding.basis}\n  Impact: ${finding.impact}\n  Verify: ${finding.verification}`).join('\n')
          + (phase === 'actual'
            ? '\n\nRemote merge already happened; this result is integrated-unaccepted. No closure or downstream release is authorized.'
            : '\n\nNo implementation statement grants approval. The Ticket remains open.'));
        ctx.ui.notify(`REVIEW_FINDINGS: ${phase} ${codeSha} ${findings.html_url}`, 'error');
      }
      throw error;
    }
  };
  const candidate = await reviewedGate(versions, 'candidate');
  await input.assertScope();
  await requireRemoteHead(cwd, input.feature, B);
  let latest = await remote.pull(before.number);
  expectedPull(latest, input, ticket.issue.number, H);
  if (latest.merged || latest.state !== 'open' || latest.base.sha !== B) throw new PreflightError('EVIDENCE_STALE', 'PR no longer matches the validated candidate');
  if (latest.draft) latest = await remote.ready(latest.number);
  await input.assertScope();
  await github.inspectProtection(input.feature);
  await remote.requireMergeStrategy();
  latest = await remote.pull(before.number);
  expectedPull(latest, input, ticket.issue.number, H);
  if (latest.draft || latest.merged || latest.state !== 'open' || latest.base.sha !== B) throw new PreflightError('EVIDENCE_STALE', 'Ready PR changed before merge');
  await requireRemoteHead(cwd, input.feature, B);
  signal.throwIfAborted();
  const M = await remote.merge(before.number, H);
  let facts: IntegrationFacts = { ticket: ticket.issue.number, M, phase: 'merged-unaccepted' };
  onFacts(facts);
  try {
    const merged = await remote.pull(before.number);
    expectedPull(merged, input, ticket.issue.number, H);
    if (!merged.merged || merged.state !== 'closed' || merged.merge_commit_sha !== M) {
      throw new PreflightError('REMOTE_RESULT_UNKNOWN', 'Merge response and actual PR do not confirm the same merged version');
    }
    await git(cwd, ['fetch', '--no-write-fetch-head', 'origin', M]);
    await requireRemoteHead(cwd, input.feature, M);
    if (JSON.stringify(await parents(cwd, M)) !== JSON.stringify([B, H]) || await tree(cwd, M) !== await tree(cwd, C)) {
      throw new PreflightError('INTEGRATION_DRIFT', 'Remote merge happened but its parents/tree differ from the verified candidate; no rollback, closure or downstream release');
    }
    signal.throwIfAborted();
    await input.assertScope();
    const total = await ensureDraftTotal(input);
    if (!total) throw new PreflightError('DELIVERY_NO_DIFF', 'Merged result has no effective main difference; preserve it and request a decision');
    const actual = M === C ? candidate : await reviewedGate({ ...versions, M }, 'actual');
    await input.assertScope();
    await requireRemoteHead(cwd, input.feature, M);
    const actualPr = await remote.pull(before.number);
    if (!actualPr.merged || actualPr.merge_commit_sha !== M || actualPr.head.sha !== H) throw new PreflightError('REMOTE_DRIFT', 'Merged PR no longer matches delivery evidence');
    const totalPr = await remote.pull(total.number);
    if (!totalPr.draft || totalPr.state !== 'open' || totalPr.head.sha !== M || totalPr.base.ref !== 'main') throw new PreflightError('REMOTE_DRIFT', 'Total PR must remain open Draft at the accepted feature SHA');
    const delivery = await remote.comment(ticket.issue.number, `Ticket delivery evidence for Spec #${input.plan.spec.number}\n\n`
      + `Ticket PR: ${actualPr.html_url}\nDraft total PR: ${totalPr.html_url}\n`
      + `H: \`${H}\`\nB: \`${B}\`\nC: \`${C}\`\nM: \`${M}\`\nScope: \`${input.scopeDigest}\`\n\n`
      + `${evidenceText(candidate)}\n${M !== C ? evidenceText(actual) : '- Candidate and actual commit identities are equal; the same evidence applies.'}\n\n`
      + 'Actual integration and independent gates verified. Closure will be read back before this Ticket can release downstream work.');
    await input.assertScope();
    await requireRemoteHead(cwd, input.feature, M);
    await remote.comment(totalPr.number, `Ticket #${ticket.issue.number}: ${actualPr.html_url}\n\n`
      + `Actual integration: \`${M}\`\nDelivery index: ${delivery.html_url}\n\n`
      + `${evidenceText(candidate)}\n${M !== C ? evidenceText(actual) : '- Candidate and actual commit identities are equal.'}\n\n`
      + 'This total PR remains Draft; full-Spec acceptance and final readiness are still required.');
    await input.assertScope();
    await requireRemoteHead(cwd, input.feature, M);
    facts = { ...facts, phase: 'closure-pending' }; onFacts(facts);
    await remote.closeIssue(ticket.issue.number);
    facts = { ...facts, phase: 'closed-unaccepted' }; onFacts(facts);
    // GitHub has no transaction spanning scope, branch and Issue state. Detect
    // external writes after closure too; never pretend an applied closure vanished.
    await input.assertScope();
    await requireRemoteHead(cwd, input.feature, M);
    facts = { ...facts, phase: 'delivered' }; onFacts(facts);
    ctx.ui.notify(`TICKET_DELIVERED: #${ticket.issue.number} ${M} ${actual.url}`, 'info');
    return { number: ticket.issue.number, state: 'delivered', pr: actualPr };
  } catch (error) {
    ctx.ui.notify(`INTEGRATED_UNACCEPTED: Ticket #${ticket.issue.number} ${M}; ${facts.phase}; actual remote effects are preserved; no downstream release`, 'error');
    throw error;
  }
}
