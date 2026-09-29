import { PreflightError } from './contract.ts';
import type { ExecutionInput } from './execution.ts';
import { runImplementation, type ImplementationResult } from './agent-run.ts';
import { prepareRepair, type PreparedRepair } from './repair-workspace.ts';
import { checkTicketWorkspace, workingTreeDigest, type TicketWorkspace } from './ticket-workspace.ts';
import { createProbe } from './workspace.ts';
import { run } from './process.ts';

// The conflict itself may make the project's scripts unparsable. Its resource
// lifecycle therefore runs from immutable H, with the same owned resource dir.
// C/M gates still run their own commands; these H commands grant no gate pass.
export async function runRepairImplementation(input: ExecutionInput, ticket: number, workspace: TicketWorkspace, B: string,
  prompt: (prepared: PreparedRepair) => string, C?: string): Promise<{ result: ImplementationResult; prepared: PreparedRepair }> {
  const { signal, contract } = input;
  return input.resources.run(ticket, 'repair', signal, async cleaned => {
  const label = (kind: string) => ({ ticket, phase: 'repair', kind, codeSha: workspace.base });
  const lifecycle = await createProbe(input.cwd, workspace.base, signal);
  const env = { FLOW_RESOURCE_DIR: workspace.resources, FLOW_CODE_SHA: workspace.base, FLOW_REPOSITORY: input.repository,
    FLOW_STAGE: 'repair', FLOW_TICKET: String(ticket) };
  const execute = async (name: 'prepare' | 'cleanup', cancellable: boolean) => {
    const command = () => run(contract.commands[name], { cwd: lifecycle.cwd, env, signal: cancellable ? signal : undefined,
      timeoutMs: contract.commandTimeoutMs, label: `Repair ${name} from immutable head`, operation: name });
    if (name === 'cleanup') await input.activities.runCleanup(label(name), command);
    else await input.activities.run(label(name), signal, command);
    await lifecycle.check();
  };
  let prepared: PreparedRepair | undefined; let result: ImplementationResult | undefined; let failure: unknown;
  const before = await workingTreeDigest(workspace.cwd);
  try {
    await execute('prepare', true); await checkTicketWorkspace(workspace);
    if (before !== await workingTreeDigest(workspace.cwd)) throw new PreflightError('WORKSPACE_DRIFT', 'Repair preparation changed owned source outside controller merge preparation');
    prepared = await prepareRepair(workspace, B, signal, C);
    result = await input.activities.run(label('implementation'), signal, () => runImplementation({ cwd: workspace.cwd, resources: workspace.resources, environment: env,
      contract, ctx: input.ctx, signal, prompt: prompt(prepared!) }));
  } catch (error) { failure = error; }
  if (failure instanceof PreflightError && failure.code === 'PROCESS_UNQUIESCED') throw failure;
  await checkTicketWorkspace(workspace); await lifecycle.check();
  const beforeCleanup = await workingTreeDigest(workspace.cwd);
  try { await execute('cleanup', false); }
  catch (error) {
    if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
    throw new PreflightError('CLEANUP_FAILED', 'Repair cleanup could not complete from immutable H; preserve resources and all worktrees');
  }
  await checkTicketWorkspace(workspace);
  if (beforeCleanup !== await workingTreeDigest(workspace.cwd)) throw new PreflightError('WORKSPACE_DRIFT', 'Repair cleanup changed owned source');
  cleaned();
  if (failure) throw failure;
  signal.throwIfAborted(); await lifecycle.remove();
  return { result: result!, prepared: prepared! };
  });
}
