import { join } from 'node:path';
import { instructionSnapshot } from './agents.ts';
import { PreflightError, readContract } from './contract.ts';
import { publishEvidence, type Evidence } from './evidence.ts';
import { evidenceContext } from './evidence-context.ts';
import { runReportedCommand } from './command-outcome.ts';
import type { ExecutionInput } from './execution.ts';
import type { TicketPlan } from './plan.ts';
import { verifyMutationEvidence, type ImplementationEvidence } from './mutation-evidence.ts';
import { acceptanceResult, digest } from './probe.ts';
import { git, run } from './process.ts';
import { runReview, type ReviewResult } from './review.ts';
import { createProbe } from './workspace.ts';

export interface Versions { H: string; B: string; C: string; M?: string; }
export interface GateEvidence extends Evidence { phase: 'candidate' | 'actual'; versions: Versions; review: ReviewResult; }
export class ReviewBlocked extends PreflightError {
  constructor(readonly review: ReviewResult) { super('REVIEW_BLOCKED', 'Independent review found blocking defects; implementation statements cannot authorize integration'); }
}

export async function ticketGate(input: ExecutionInput, ticket: TicketPlan, versions: Versions, phase: 'candidate' | 'actual', proof?: ImplementationEvidence): Promise<GateEvidence> {
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
  const execute = async (name: keyof typeof contract.commands, cancellable = true) => {
    const options = { cwd: workspace.cwd, env, operation: name, signal: cancellable ? signal : undefined,
      timeoutMs: contract.commandTimeoutMs, label: `${phase} ${name}` };
    try {
      const output = name === 'check' || name === 'accept'
        ? await runReportedCommand(name, codeSha, contract.commands[name], options)
        : await run(contract.commands[name], options);
      await workspace.check();
      return output;
    } catch (error) {
      if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
      await workspace.check();
      throw error;
    }
  };
  let acceptance: ReturnType<typeof acceptanceResult> | undefined;
  let review: ReviewResult | undefined;
  let failure: unknown;
  const diff = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', versions.B, codeSha, '--'], signal);
  const implementationEvidence = await verifyMutationEvidence(cwd, proof, versions.H, codeSha, input.scopeDigest);
  try {
    await execute('prepare');
    await execute('check');
    acceptance = acceptanceResult(await execute('accept'));
    review = await runReview({ cwd: workspace.cwd, resources: workspace.resources, environment: env,
      contract, ctx, signal, codeSha, scopeDigest: input.scopeDigest,
      prompt: JSON.stringify({ task: 'Independently review the exact integration result against its approved scope. Inspect actual code and the supplied diff. Explicitly inspect changed commands, removed assertions and reduced coverage. Never accept an implementation summary as approval. A new behavior test may extend coverage; weakened existing acceptance requires an approved scope change. Report correctness, security, explicit-spec or mandatory-standard defects with basis, impact and a verifiable resolution. Style preferences are suggestions only.',
        spec: input.plan.spec, ticket, approvedChanges: [], versions, phase, codeSha, scopeDigest: input.scopeDigest,
        commandSource: '.pi/flow.json', commands: contract.commands, acceptance,
        instructions: approvedInstructions, sourceDiff: diff, implementationEvidence,
      }, null, 2),
    });
    await workspace.check();
    if (review.blockers.length) throw new ReviewBlocked(review);
  } catch (error) { failure = error; }
  if (failure instanceof PreflightError && failure.code === 'PROCESS_UNQUIESCED') throw failure;
  await workspace.check();
  try { await execute('cleanup', false); }
  catch (error) {
    if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
    throw new PreflightError('CLEANUP_FAILED', 'Gate cleanup failed; preserve candidate and resources; no integration authority', error instanceof PreflightError ? error.detail : undefined);
  }
  if (failure) throw failure;
  signal.throwIfAborted();
  const report = { schema: 3, generator: 'pi-implement-flow/ticket-gate-v1', kind: 'ticket-gate', phase,
    repository: input.repository, spec: input.plan.spec.number, ticket: ticket.issue.number,
    codeSha, scopeDigest: input.scopeDigest, contractDigest: digest(contract), instructionsDigest: digest(approvedInstructions),
    versions, approvedContext, commandSource: '.pi/flow.json', commands: ['prepare', 'check', 'accept', 'cleanup'],
    commandDefinitions: Object.fromEntries(['prepare', 'check', 'accept', 'cleanup'].map(name => [name, contract.commands[name as keyof typeof contract.commands]])),
    commandTimeoutMs: contract.commandTimeoutMs,
    reviewSource: { isolation: 'independent-context', tools: contract.agents.review.tools,
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null },
    prerequisites: { resourcesMode: contract.resources.mode, resourcesDescription: contract.resources.description, node: process.version },
    implementationEvidence, acceptance, review, cleanup: 'passed', retentionDays: contract.artifacts.retentionDays, sourceDiffDigest: digest(diff) };
  // Once publication begins, let it finish and verify bytes even if a pause arrives.
  // It is one trusted project operation, not permission to start the next operation.
  const evidence = await publishEvidence({ cwd, repository: input.repository, codeSha, contract, path: reportPath, report,
    beforePublish: () => signal.throwIfAborted(), publish: () => execute('publish', false) });
  signal.throwIfAborted();
  await workspace.remove();
  ctx.ui.notify(`GATE_PASSED: ${phase} ${codeSha} ${evidence.url}`, 'info');
  return { ...evidence, phase, versions, review: review! };
}
