import { join } from 'node:path';
import { instructionSnapshot } from './agents.ts';
import { PreflightError, readContract } from './contract.ts';
import { ReportedBehaviorFailure, runReportedCommand, type ReportedBehavior } from './command-outcome.ts';
import { publishEvidence, type Evidence } from './evidence.ts';
import { evidenceContext } from './evidence-context.ts';
import type { ExecutionInput } from './execution.ts';
import type { TicketPlan } from './plan.ts';
import { verifyMutationEvidence, type ImplementationEvidence } from './mutation-evidence.ts';
import { acceptanceResult, digest } from './probe.ts';
import { git, run } from './process.ts';
import { runReview, type ReviewResult } from './review.ts';
import { createProbe } from './workspace.ts';
import { GateBehaviorFailure, ReviewBlocked, type GateRepairContext, type PublishedDefect } from './gate-defect.ts';
import { verifyResolutions, type AssertionFact } from './repair-progress.ts';
export { GateBehaviorFailure, ReviewBlocked } from './gate-defect.ts';

export interface Versions { H: string; B: string; C: string; M?: string; }
export interface GateEvidence extends Evidence { phase: 'candidate' | 'actual'; versions: Versions; review: ReviewResult; }

export async function ticketGate(input: ExecutionInput, ticket: TicketPlan, versions: Versions, phase: 'candidate' | 'actual',
  proof?: ImplementationEvidence, repair: GateRepairContext = { previousBlockers: [] }): Promise<GateEvidence> {
  const { cwd, contract, signal, ctx } = input;
  const codeSha = phase === 'candidate' ? versions.C : versions.M;
  if (!codeSha) throw new PreflightError('VERSION_INVALID', 'Actual integration SHA is required');
  signal.throwIfAborted();
  const approvedInstructions = input.approvedInstructions;
  const approvedContext = evidenceContext(input.repository, input.plan, ticket, contract, approvedInstructions, input.scopeDigest);
  ctx.ui.notify(`GATE_STARTED: ${phase} ${codeSha}`, 'info');
  const workspace = await createProbe(cwd, codeSha, signal);
  const reportPath = join(workspace.resources, 'gate.json');
  const env = { FLOW_RESOURCE_DIR: workspace.resources, FLOW_CODE_SHA: codeSha, FLOW_REPOSITORY: input.repository,
    FLOW_REPORT: reportPath, FLOW_STAGE: phase };
  if (digest(await readContract(workspace.cwd)) !== digest(contract)
    || digest(await instructionSnapshot(workspace.cwd, contract)) !== digest(approvedInstructions)) {
    throw new PreflightError('SCOPE_CHANGED', 'Candidate changed approved commands or role instructions; preserve work and request a scope decision');
  }
  const commandResults: Record<string, 'passed' | 'failed' | 'not-run'> = { prepare: 'not-run', check: 'not-run', accept: 'not-run', cleanup: 'not-run' };
  const assertions: AssertionFact[] = [];
  const execute = async (name: keyof typeof contract.commands, cancellable = true) => {
    const options = { cwd: workspace.cwd, env, signal: cancellable ? signal : undefined,
      timeoutMs: contract.commandTimeoutMs, label: `${phase} ${name}` };
    try {
      const output = name === 'check' || name === 'accept'
        ? await runReportedCommand(name, codeSha, contract.commands[name], options) : await run(contract.commands[name], options);
      await workspace.check();
      if (name !== 'publish') commandResults[name] = 'passed';
      return output;
    } catch (error) {
      if (name !== 'publish') commandResults[name] = 'failed';
      if (!(error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED')) await workspace.check();
      throw error;
    }
  };
  let acceptance: ReturnType<typeof acceptanceResult> | undefined;
  let review: ReviewResult | undefined;
  let behavior: ReportedBehavior | undefined;
  let failure: unknown;
  const diff = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', versions.B, codeSha, '--'], signal);
  const implementationEvidence = await verifyMutationEvidence(cwd, proof, versions.H, codeSha, input.scopeDigest);
  try {
    await execute('prepare');
    try {
      const check = await execute('check');
      // Legacy successful check output has no assertion identity. Only an actual
      // success envelope can supply comparable facts; never invent passed IDs.
      let checkValue;
      try { checkValue = JSON.parse(check); } catch { /* Legacy output is allowed. */ }
      if (checkValue?.passed === true && Array.isArray(checkValue.assertions)) {
        const result = acceptanceResult(check); assertions.push(...result.assertions.map(item => ({ ...item, command: 'check' as const })));
      }
      acceptance = acceptanceResult(await execute('accept'));
      assertions.push(...acceptance.assertions.map(item => ({ ...item, command: 'accept' as const })));
    } catch (error) {
      if (!(error instanceof ReportedBehaviorFailure)) throw error;
      behavior = error.report;
      assertions.push(...behavior.assertions.map(item => ({ ...item, command: behavior!.command })));
    }
    // Only a normally ended strict behavior failure can reach this fresh review.
    // Infrastructure, unknown effects and process lifecycle failures never do.
    review = await runReview({ cwd: workspace.cwd, resources: workspace.resources, environment: env,
      contract, ctx, signal, codeSha, scopeDigest: input.scopeDigest, previousBlockers: repair.previousBlockers,
      prompt: JSON.stringify({ task: 'Independently review the exact integration result against approved scope. Inspect code, diff, changed commands, removed assertions and reduced coverage. The command statuses below are factual: failed or not-run never means passed. Report concrete defects and verify existing acceptance meaning and coverage is preserved. Implementation statements are not approval.',
        spec: input.plan.spec, ticket, approvedChanges: [], versions, phase, codeSha, scopeDigest: input.scopeDigest,
        commandSource: '.pi/flow.json', commands: contract.commands, commandResults, assertions, acceptance, behavior,
        instructions: approvedInstructions, sourceDiff: diff, implementationEvidence, previousBlockers: repair.previousBlockers,
      }, null, 2),
    });
    await workspace.check();
    await verifyResolutions(cwd, codeSha, repair.previousBlockers, review, assertions);
    for (const old of repair.previousAssertions ?? []) {
      if (old.command === 'accept' && !assertions.some(item => item.command === old.command && item.name === old.name)) {
        throw new PreflightError('ACCEPTANCE_REGRESSED', 'A previously observed acceptance assertion disappeared; no repair or success may hide removed coverage');
      }
    }
  } catch (error) { failure = error; }
  if (failure instanceof PreflightError && failure.code === 'PROCESS_UNQUIESCED') throw failure;
  await workspace.check();
  try { await execute('cleanup', false); }
  catch (error) {
    if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
    throw new PreflightError('CLEANUP_FAILED', 'Gate cleanup failed; preserve candidate and resources; no integration authority');
  }
  if (failure) throw failure;
  signal.throwIfAborted();
  const blocked = !!review!.blockers.length || !!review!.resolutions?.some(item => item.status === 'unresolved');
  const defect = !!behavior || blocked;
  const report = { schema: 3, generator: 'pi-implement-flow/ticket-gate-v1', kind: defect ? 'ticket-gate-failure' : 'ticket-gate', phase,
    repository: input.repository, spec: input.plan.spec.number, ticket: ticket.issue.number,
    codeSha, scopeDigest: input.scopeDigest, contractDigest: digest(contract), instructionsDigest: digest(approvedInstructions),
    versions, approvedContext, commandSource: '.pi/flow.json', commands: ['prepare', 'check', 'accept', 'cleanup'],
    commandDefinitions: Object.fromEntries(['prepare', 'check', 'accept', 'cleanup'].map(name => [name, contract.commands[name as keyof typeof contract.commands]])),
    commandResults, commandTimeoutMs: contract.commandTimeoutMs,
    reviewSource: { isolation: 'independent-context', tools: contract.agents.review.tools,
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null },
    prerequisites: { resourcesMode: contract.resources.mode, resourcesDescription: contract.resources.description, node: process.version },
    implementationEvidence, assertions, acceptance, behavior, review, previousBlockers: repair.previousBlockers,
    cleanup: 'passed', retentionDays: contract.artifacts.retentionDays, sourceDiffDigest: digest(diff) };
  const evidence = await publishEvidence({ cwd, repository: input.repository, codeSha, contract, path: reportPath, report,
    beforePublish: () => signal.throwIfAborted(), publish: () => execute('publish', false) });
  await workspace.check();
  signal.throwIfAborted();
  await input.assertScope();
  if (defect) {
    const binding: PublishedDefect = { evidence, phase, codeSha, versions, scopeDigest: input.scopeDigest,
      contractDigest: digest(contract), instructionsDigest: digest(approvedInstructions),
      observation: { codeSha, B: versions.B, scopeDigest: input.scopeDigest, contractDigest: digest(contract), instructionsDigest: digest(approvedInstructions),
        evidenceSha256: evidence.sha256, assertions, review: review!, previousBlockers: repair.previousBlockers } };
    ctx.ui.notify(`GATE_FAILED: ${phase} ${codeSha} ${behavior ? 'behavior' : 'review'} ${evidence.url} ${evidence.sha256}`, 'error');
    if (behavior) throw new GateBehaviorFailure(behavior, binding, review!);
    throw new ReviewBlocked(review!, binding);
  }
  await workspace.remove();
  ctx.ui.notify(`GATE_PASSED: ${phase} ${codeSha} ${evidence.url}`, 'info');
  return { ...evidence, phase, versions, review: review! };
}
