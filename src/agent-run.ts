import { runRoleSession, type RoleSessionInput } from './agent-session.ts';
import { PreflightError } from './contract.ts';

export type ImplementationResult = { kind: 'implemented'; summary: string } | { kind: 'blocked'; question: string };
export type ImplementationInput = RoleSessionInput;

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
  const prompt = `${input.prompt}\n\nImplementation response protocol:\n`
    + 'Before the first file modification, check whether the supplied requirements are unambiguous. '
    + 'If requirements need a human decision, do not edit and return exactly {"kind":"blocked","question":"the decision needed"}. '
    + 'Otherwise implement only this Ticket. Do not change its acceptance criteria or remove/weaken existing acceptance. '
    + 'Do not commit, push or create/merge a PR; the controller owns delivery. '
    + 'The bash tool accepts only command names prepare, check, accept, without timeout or extra arguments. '
    + 'When implementation is ready, return exactly {"kind":"implemented","summary":"a concise non-sensitive change summary"}. '
    + 'Return JSON only, without Markdown. Neither your summary nor a command success constitutes delivery acceptance.';
  return result(await runRoleSession({ ...input, prompt }, 'implementation'));
}
