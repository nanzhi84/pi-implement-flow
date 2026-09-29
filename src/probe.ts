import { createHash } from 'node:crypto';
import { PreflightError, type Contract } from './contract.ts';
import { publishEvidence } from './evidence.ts';
import { evidencePath } from './evidence-location.ts';
import { run } from './process.ts';
import { createProbe } from './workspace.ts';

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function acceptanceResult(output: string): { passed: true; assertions: { name: string; passed: true }[] } {
  let value;
  try { value = JSON.parse(output); } catch { throw new PreflightError('ACCEPTANCE_INVALID', 'accept must emit a JSON behavior-assertion report, not a textual success claim'); }
  if (value?.passed !== true || !Array.isArray(value.assertions) || !value.assertions.length
    || value.assertions.some((a: { name?: unknown; passed?: unknown }) => !a || a.passed !== true || typeof a.name !== 'string' || !/^[a-z0-9._-]{1,80}$/.test(a.name))) {
    throw new PreflightError('ACCEPTANCE_INVALID', 'Behavior assertions must be nonempty, passed and have safe machine-readable names');
  }
  return { passed: true, assertions: value.assertions.map((a: { name: string }) => ({ name: a.name, passed: true })) };
}

export async function probeProject(
  cwd: string, repository: string, sha: string, scopeDigest: string, contract: Contract, signal: AbortSignal,
): Promise<string> {
  const workspace = await createProbe(cwd, sha, signal);
  const reportPath = evidencePath(workspace.resources, contract, 'preflight.json');
  const env = { FLOW_RESOURCE_DIR: workspace.resources, FLOW_CODE_SHA: sha, FLOW_REPOSITORY: repository, FLOW_REPORT: reportPath };
  const execute = async (phase: keyof Contract['commands'], cancellable = true, extraEnvironment: NodeJS.ProcessEnv = {}) => {
    const output = await run(contract.commands[phase], {
      cwd: workspace.cwd, env: { ...env, ...extraEnvironment }, timeoutMs: contract.commandTimeoutMs,
      signal: cancellable ? signal : undefined, label: phase, operation: phase,
    });
    await workspace.check();
    return output;
  };
  let acceptance: ReturnType<typeof acceptanceResult> | undefined;
  let failure: unknown;
  try {
    await execute('prepare');
    await execute('check');
    acceptance = acceptanceResult(await execute('accept'));
  } catch (error) { failure = error; }
  if (failure instanceof PreflightError && failure.code === 'PROCESS_UNQUIESCED') throw failure;
  await workspace.check();
  try { await execute('cleanup', false); }
  catch (error) {
    if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
    throw new PreflightError('CLEANUP_FAILED', 'Project cleanup failed; preserve probe workspace and stop; no publication or startup', error instanceof PreflightError ? error.detail : undefined);
  }
  if (failure) {
    await workspace.remove();
    throw failure;
  }
  signal.throwIfAborted();
  const report = {
    schema: 2, generator: 'pi-implement-flow/probe-v2-head-checked',
    codeSha: sha, scopeDigest, contractDigest: digest(contract),
    source: '.pi/flow.json', commands: ['prepare', 'check', 'accept', 'cleanup'],
    node: process.version, commandTimeoutMs: contract.commandTimeoutMs,
    acceptance, cleanup: 'passed', retentionDays: contract.artifacts.retentionDays,
  };
  const evidence = await publishEvidence({ cwd, repository, codeSha: sha, contract,
    path: reportPath, report, publish: environment => execute('publish', true, environment), signal });
  signal.throwIfAborted();
  await workspace.remove();
  return evidence.url;
}
