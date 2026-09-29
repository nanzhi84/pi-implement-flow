import { join } from 'node:path';
import { PreflightError } from './contract.ts';
import { publishEvidence } from './evidence.ts';
import { evidenceContext } from './evidence-context.ts';
import type { ExecutionInput } from './execution.ts';
import { verifyMutationEvidence } from './mutation-evidence.ts';
import { digest } from './probe.ts';
import { run } from './process.ts';
import type { RepairSubmission, TextConflictDefect } from './repair.ts';
import type { MergePreparation } from './merge-preparation.ts';
import { createProbe } from './workspace.ts';

// A real controller-computed text conflict has H/B but no executable C. Its
// report says exactly that; it cannot be confused with a passed candidate gate.
export async function publishConflict(input: ExecutionInput, submission: RepairSubmission, preparation: MergePreparation): Promise<TextConflictDefect> {
  const { signal, contract, cwd } = input;
  if (!preparation.conflicts.length || preparation.H !== submission.pr.head.sha) throw new PreflightError('CONFLICT_INVALID', 'A current reproducible text conflict is required');
  return input.resources.run(submission.number, 'conflict', signal, async cleaned => {
  const label = (kind: string) => ({ ticket: submission.number, phase: 'conflict', kind, codeSha: preparation.H });
  const workspace = await createProbe(cwd, preparation.H, signal);
  const path = join(workspace.resources, 'conflict.json');
  const env = { FLOW_RESOURCE_DIR: workspace.resources, FLOW_CODE_SHA: preparation.H, FLOW_REPOSITORY: input.repository,
    FLOW_REPORT: path, FLOW_STAGE: 'conflict', FLOW_TICKET: String(submission.number) };
  const execute = async (name: 'prepare' | 'cleanup' | 'publish', cancellable = true) => {
    try {
      const command = () => run(contract.commands[name], { cwd: workspace.cwd, env, signal: cancellable ? signal : undefined,
        timeoutMs: contract.commandTimeoutMs, label: `conflict ${name}`, operation: name });
      const result = name === 'cleanup' ? await input.activities.runCleanup(label(name), command)
        : await input.activities.run(label(name), signal, command);
      await workspace.check(); return result;
    } catch (error) {
      if (!(error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED')) await workspace.check();
      throw error;
    }
  };
  let failure: unknown;
  try { await execute('prepare'); } catch (error) { failure = error; }
  if (failure instanceof PreflightError && failure.code === 'PROCESS_UNQUIESCED') throw failure;
  await workspace.check();
  try { await execute('cleanup', false); }
  catch (error) {
    if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
    throw new PreflightError('CLEANUP_FAILED', 'Conflict evidence cleanup failed; no repair authorized');
  }
  cleaned();
  if (failure) throw failure;
  await input.scope.assert();
  const report = { schema: 1, generator: 'pi-implement-flow/ticket-conflict-v1', kind: 'ticket-integration-conflict',
    repository: input.repository, spec: input.plan.spec.number, ticket: submission.number, codeSha: preparation.H,
    scopeDigest: input.scopeDigest, contractDigest: digest(contract), instructionsDigest: digest(input.approvedInstructions),
    approvedContext: evidenceContext(input.repository, input.plan, submission.ticket, contract, input.approvedInstructions, input.scopeDigest),
    preparation, implementationEvidence: await verifyMutationEvidence(cwd, submission.implementationEvidence, preparation.H, preparation.H, input.scopeDigest),
    commandResults: { prepare: 'passed', check: 'not-run', accept: 'not-run', review: 'not-run', cleanup: 'passed' },
    boundary: 'No executable candidate commit exists for this conflict. A repair must preserve both approved behaviors, then obtain a fresh actual candidate and all independent gates.',
    cleanup: 'passed', retentionDays: contract.artifacts.retentionDays };
  const evidence = await publishEvidence({ cwd, repository: input.repository, codeSha: preparation.H, contract, path, report,
    beforePublish: () => signal.throwIfAborted(), publish: () => execute('publish', false) });
  await workspace.check();
  signal.throwIfAborted(); await input.scope.assert();
  input.ctx.ui.notify(`GATE_FAILED: candidate ${preparation.H} text-conflict ${evidence.url} ${evidence.sha256}`, 'error');
  return { kind: 'text-conflict', preparation, evidence };
  });
}
