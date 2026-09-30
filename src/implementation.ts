import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { runImplementation, type ImplementationResult } from './agent-run.ts';
import { PreflightError, type Contract } from './contract.ts';
import { run } from './process.ts';
import { checkTicketWorkspace, workingTreeDigest, type TicketWorkspace } from './ticket-workspace.ts';

export async function implementInWorkspace(
  workspace: TicketWorkspace, repository: string, contract: Contract, ctx: ExtensionContext, signal: AbortSignal, prompt: string,
): Promise<ImplementationResult> {
  const env = { FLOW_RESOURCE_DIR: workspace.resources, FLOW_CODE_SHA: workspace.base, FLOW_REPOSITORY: repository };
  let failure: unknown;
  let result: ImplementationResult | undefined;
  const beforePrepare = await workingTreeDigest(workspace.cwd);
  try {
    await run(contract.commands.prepare, { cwd: workspace.cwd, env, signal, timeoutMs: contract.commandTimeoutMs, label: 'Ticket prepare', operation: 'prepare' });
    await checkTicketWorkspace(workspace);
    if (await workingTreeDigest(workspace.cwd) !== beforePrepare) throw new PreflightError('WORKSPACE_DRIFT', 'Ticket preparation changed source; no Agent dispatched');
    result = await runImplementation({ cwd: workspace.cwd, resources: workspace.resources, contract, ctx, signal, prompt, environment: env });
  } catch (error) { failure = error; }
  if (failure instanceof PreflightError && failure.code === 'PROCESS_UNQUIESCED') throw failure;
  // Do not run more project code in a workspace whose identity is no longer known.
  await checkTicketWorkspace(workspace);
  const beforeCleanup = await workingTreeDigest(workspace.cwd);
  try {
    // Cancellation must not skip cleanup of the exclusively owned test data.
    await run(contract.commands.cleanup, { cwd: workspace.cwd, env, timeoutMs: contract.commandTimeoutMs, label: 'Ticket cleanup', operation: 'cleanup' });
  } catch (error) {
    if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
    throw new PreflightError('CLEANUP_FAILED', 'Ticket cleanup failed; preserve workspace and resources for reconciliation', error instanceof PreflightError ? error.detail : undefined);
  }
  await checkTicketWorkspace(workspace);
  if (await workingTreeDigest(workspace.cwd) !== beforeCleanup) throw new PreflightError('WORKSPACE_DRIFT', 'Ticket cleanup changed source; preserve work and refuse delivery');
  if (failure) throw failure;
  signal.throwIfAborted();
  return result!;
}
