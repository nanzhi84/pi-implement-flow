import { ModelRuntime, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createRole } from './agents.ts';
import { PreflightError, type Contract } from './contract.ts';
import type { MutationEvidence } from './mutation-evidence.ts';
import { classifyFailure, type FailureOperation } from './failure.ts';

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
  const operation: FailureOperation = roleName === 'implementation' ? 'implementation-model' : 'review-model';
  signal.throwIfAborted();
  const setup = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let runtime: ModelRuntime;
  let model: NonNullable<ExtensionContext['model']>;
  try {
    if (!ctx.model) throw new PreflightError('AGENT_UNAVAILABLE', 'Selected model required',
      { operation: 'model-setup', kind: 'configuration', reason: 'missing-configuration', transient: false });
    runtime = await ModelRuntime.create({ signal: setup, allowModelNetwork: false });
    const selected = runtime.getModel(ctx.model.provider, ctx.model.id);
    if (!selected) throw new PreflightError('AGENT_UNAVAILABLE', 'Selected model is not configured',
      { operation: 'model-setup', kind: 'configuration', reason: 'missing-configuration', transient: false });
    if (!(await runtime.checkAuth(selected.provider, { signal: setup }))) throw new PreflightError('AGENT_UNAVAILABLE', 'Configured authentication required',
      { operation: 'model-setup', kind: 'configuration', reason: 'authentication', transient: false });
    model = selected;
    setup.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    throw new PreflightError('AGENT_UNAVAILABLE', `The selected ${roleName} model or authentication is unavailable`,
      error instanceof PreflightError ? error.detail : classifyFailure('model-setup', error));
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
    if (event.type === 'auto_retry_start' && !signal.aborted) {
      const detail = classifyFailure(operation, event.errorMessage);
      ctx.ui.notify(`MODEL_RETRY: ${roleName}; ${detail.kind}/${detail.reason}; recovery is owned by the approved SDK policy`, 'info');
    }
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
      throw new PreflightError('AGENT_FAILED', `${label} model did not finish successfully; preserve the worktree and inspect the provider privately`, classifyFailure(operation, final?.role === 'assistant' ? final.errorMessage : undefined));
    }
    text = final.content.filter(block => block.type === 'text').map(block => block.text).join('');
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    signal.throwIfAborted();
    throw new PreflightError('AGENT_FAILED', `${label} Agent execution failed; preserve its worktree and inspect the provider privately`, classifyFailure(operation, error));
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      await abortWork;
      await session.abort();
      await role.settleTools();
      if (abortFailure || !session.isIdle) throw new PreflightError('PROCESS_UNQUIESCED', `${label} Agent cancellation could not establish idle state; retain controller ownership`, { operation, kind: 'unquiesced', reason: 'process-unquiesced' });
    } catch (error) {
      if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
      throw new PreflightError('PROCESS_UNQUIESCED', `${label} Agent tools or cancellation did not settle; retain controller ownership`, { operation, kind: 'unquiesced', reason: 'process-unquiesced' });
    } finally {
      unsubscribe();
      session.dispose();
    }
  }
  // Evidence is exposed only after cancellation, tool settlement and idle checks.
  return { text, mutations: role.snapshotMutations() };
}
