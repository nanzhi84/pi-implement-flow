import { ModelRuntime, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createRole } from './agents.ts';
import { PreflightError, type Contract } from './contract.ts';
import type { MutationEvidence } from './mutation-evidence.ts';

export interface RoleSessionInput {
  cwd: string;
  contract: Contract;
  ctx: ExtensionContext;
  signal: AbortSignal;
  prompt: string;
  resources: string;
  environment?: NodeJS.ProcessEnv;
}
export interface RoleSessionResult { text: string; mutations: MutationEvidence[]; }

// Each call owns a new in-memory conversation. Neither role can supply or inherit
// the other role's session, messages, tools, or model-reported approval identity.
export async function runRoleSession(input: RoleSessionInput, roleName: 'implementation' | 'review'): Promise<RoleSessionResult> {
  const { cwd, contract, ctx, signal, prompt, resources } = input;
  const label = roleName === 'implementation' ? 'Implementation' : 'Review';
  signal.throwIfAborted();
  const setup = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let runtime: ModelRuntime;
  let model: NonNullable<ExtensionContext['model']>;
  try {
    if (!ctx.model) throw new Error('Selected model required');
    runtime = await ModelRuntime.create({ signal: setup, allowModelNetwork: false });
    const selected = runtime.getModel(ctx.model.provider, ctx.model.id);
    if (!selected || !(await runtime.checkAuth(selected.provider, { signal: setup }))) throw new Error('Configured authentication required');
    model = selected;
    setup.throwIfAborted();
  } catch {
    signal.throwIfAborted();
    throw new PreflightError('AGENT_UNAVAILABLE', `The selected ${roleName} model or authentication is unavailable`);
  }
  const role = await createRole(cwd, contract, roleName, runtime, model, { signal, resources, commandEnv: input.environment });
  const { session } = role;
  let abortWork: Promise<void> | undefined;
  let abortFailure: unknown;
  const abort = () => {
    abortWork = (abortWork ?? Promise.resolve()).then(() => session.abort()).catch(error => { abortFailure = error; });
  };
  // prompt() performs asynchronous auth preflight before agent_start. An abort
  // during that preflight must also cancel the later actual run.
  const unsubscribe = session.subscribe(event => {
    if (signal.aborted && event.type === 'agent_start') abort();
  });
  signal.addEventListener('abort', abort, { once: true });
  let text: string;
  try {
    signal.throwIfAborted();
    await session.prompt(prompt, { expandPromptTemplates: false });
    await role.settleTools();
    signal.throwIfAborted();
    const final = session.messages.findLast(message => message.role === 'assistant');
    if (!final || final.role !== 'assistant' || final.stopReason !== 'stop' || final.errorMessage) {
      throw new PreflightError('AGENT_FAILED', `${label} model did not finish successfully; preserve the worktree and inspect the provider privately`);
    }
    text = final.content.filter(block => block.type === 'text').map(block => block.text).join('');
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    signal.throwIfAborted();
    throw new PreflightError('AGENT_FAILED', `${label} Agent execution failed; preserve its worktree and inspect the provider privately`);
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      await abortWork;
      await session.abort();
      await role.settleTools();
      if (abortFailure || !session.isIdle) throw new PreflightError('PROCESS_UNQUIESCED', `${label} Agent cancellation could not establish idle state; retain controller ownership`);
    } catch (error) {
      if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
      throw new PreflightError('PROCESS_UNQUIESCED', `${label} Agent tools or cancellation did not settle; retain controller ownership`);
    } finally {
      unsubscribe();
      session.dispose();
    }
  }
  // Evidence is exposed only after cancellation, tool settlement and idle checks.
  return { text, mutations: role.snapshotMutations() };
}
