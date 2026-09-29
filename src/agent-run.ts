import { ModelRuntime, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createRole } from './agents.ts';
import { PreflightError, type Contract } from './contract.ts';

export type ImplementationResult = { kind: 'implemented'; summary: string } | { kind: 'blocked'; question: string };
export interface ImplementationInput {
  cwd: string;
  contract: Contract;
  ctx: ExtensionContext;
  signal: AbortSignal;
  prompt: string;
  resources: string;
  environment?: NodeJS.ProcessEnv;
}

function result(text: string): ImplementationResult {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new PreflightError('AGENT_RESULT_INVALID', 'Implementation Agent must return one JSON result, without Markdown or extra text'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PreflightError('AGENT_RESULT_INVALID', 'Implementation Agent returned an invalid result');
  const data = value as Record<string, unknown>;
  const field = data.kind === 'implemented' ? 'summary' : data.kind === 'blocked' ? 'question' : undefined;
  if (!field || Object.keys(data).length !== 2 || typeof data[field] !== 'string' || !(data[field] as string).trim()
    || (data[field] as string).length > 20_000 || (data[field] as string).includes('\0')) {
    throw new PreflightError('AGENT_RESULT_INVALID', 'Implementation Agent result does not match the implemented/blocked contract');
  }
  return data.kind === 'implemented'
    ? { kind: 'implemented', summary: data.summary as string }
    : { kind: 'blocked', question: data.question as string };
}

export async function runImplementation(input: ImplementationInput): Promise<ImplementationResult> {
  const { cwd, contract, ctx, signal, prompt, resources } = input;
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
    throw new PreflightError('AGENT_UNAVAILABLE', 'The selected implementation model or authentication is unavailable');
  }
  const role = await createRole(cwd, contract, 'implementation', runtime, model, { signal, resources, commandEnv: input.environment });
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
  try {
    signal.throwIfAborted();
    await session.prompt(`${prompt}\n\nImplementation response protocol:\n`
      + 'Before the first file modification, check whether the supplied requirements are unambiguous. '
      + 'If requirements need a human decision, do not edit and return exactly {"kind":"blocked","question":"the decision needed"}. '
      + 'Otherwise implement only this Ticket. Do not change its acceptance criteria or remove/weaken existing acceptance. '
      + 'Do not commit, push or create/merge a PR; the controller owns delivery. '
      + 'The bash tool accepts only command names prepare, check, accept, without timeout or extra arguments. '
      + 'When implementation is ready, return exactly {"kind":"implemented","summary":"a concise non-sensitive change summary"}. '
      + 'Return JSON only, without Markdown. Neither your summary nor a command success constitutes delivery acceptance.',
    { expandPromptTemplates: false });
    await role.settleTools();
    signal.throwIfAborted();
    const final = session.messages.findLast(message => message.role === 'assistant');
    if (!final || final.role !== 'assistant' || final.stopReason !== 'stop' || final.errorMessage) {
      throw new PreflightError('AGENT_FAILED', 'Implementation model did not finish successfully; preserve the worktree and inspect the provider privately');
    }
    const text = final.content.filter(block => block.type === 'text').map(block => block.text).join('');
    return result(text);
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    signal.throwIfAborted();
    throw new PreflightError('AGENT_FAILED', 'Implementation Agent execution failed; preserve its worktree and inspect the provider privately');
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      await abortWork;
      await session.abort();
      await role.settleTools();
      if (abortFailure || !session.isIdle) throw new PreflightError('PROCESS_UNQUIESCED', 'Implementation Agent cancellation could not establish idle state; retain controller ownership');
    } catch (error) {
      if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
      throw new PreflightError('PROCESS_UNQUIESCED', 'Implementation Agent tools or cancellation did not settle; retain controller ownership');
    } finally {
      unsubscribe();
      session.dispose();
    }
  }
}
