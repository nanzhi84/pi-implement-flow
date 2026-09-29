import { createHash } from 'node:crypto';
import { PreflightError } from './contract.ts';
import { captureCommand, type CommandOptions } from './process.ts';
import type { FailureDetail, FailureKind, FailureReason } from './failure.ts';

export type ReportedCommand = 'check' | 'accept';
export interface ReportedAssertion { name: string; passed: boolean; }
export interface ReportedBehavior {
  command: ReportedCommand;
  codeSha: string;
  assertions: readonly ReportedAssertion[];
  reportDigest: string;
}
export class ReportedBehaviorFailure extends PreflightError {
  constructor(readonly report: ReportedBehavior) {
    super('BEHAVIOR_FAILED', `${report.command} reported explicit failed behavior for ${report.codeSha}; preserve evidence; this alone does not authorize repair`);
  }
}
const schema = 'flow-command-failure-v1';
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function invalid(command: ReportedCommand): never {
  throw new PreflightError('COMMAND_REPORT_INVALID', `${command} returned an invalid or contradictory failed-command report; no repair or delivery authority`,
    { operation: command, kind: 'configuration', reason: 'invalid-response', transient: false });
}
export async function runReportedCommand(command: ReportedCommand, codeSha: string, argv: string[], options: CommandOptions): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(codeSha)) invalid(command);
  const result = await captureCommand(argv, { ...options, operation: command });
  let value: unknown;
  if (result.exitCode === 0 || (result.exitCode === 1 && result.stdout.length <= 256 * 1024)) {
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)); } catch { /* Legacy output has no failed-behavior authority. */ }
  }
  const recognized = !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === schema;
  if (result.exitCode === 0) {
    if (recognized) invalid(command);
    return result.stdout.toString('utf8'); // Preserve the legacy successful output contract.
  }
  if (result.exitCode !== 1 || !recognized) {
    throw new PreflightError('COMMAND_FAILED', `${command} failed without a valid explicit failed-behavior report; diagnose before repair`, result.failure);
  }
  const input = value as Record<string, unknown>;
  if (input.codeSha !== codeSha) invalid(command);
  if (input.kind === 'behavior') {
    if (!record(value, ['schema', 'kind', 'codeSha', 'assertions']) || !Array.isArray(input.assertions)
      || input.assertions.length < 1 || input.assertions.length > 2048) invalid(command);
    const names = new Set<string>();
    const assertions = input.assertions.map((item: unknown): ReportedAssertion => {
      if (!record(item, ['name', 'passed']) || typeof item.name !== 'string' || !/^[a-z0-9._-]{1,80}$/.test(item.name)
        || typeof item.passed !== 'boolean' || names.has(item.name)) invalid(command);
      names.add(item.name);
      return Object.freeze({ name: item.name, passed: item.passed });
    });
    if (assertions.every(item => item.passed)) invalid(command);
    throw new ReportedBehaviorFailure(Object.freeze({ command, codeSha, assertions: Object.freeze(assertions),
      reportDigest: createHash('sha256').update(result.stdout).digest('hex') }));
  }
  const reasons: Record<string, readonly string[]> = {
    infrastructure: ['connection-refused', 'dns', 'tls', 'timeout', 'service-unavailable', 'rate-limit'],
    configuration: ['missing-dependency', 'missing-configuration', 'authentication', 'permission'],
    unknown: ['unclassified'],
  };
  if (!record(value, ['schema', 'kind', 'codeSha', 'category', 'reason']) || input.kind !== 'execution'
    || typeof input.category !== 'string' || typeof input.reason !== 'string'
    || !Object.hasOwn(reasons, input.category) || !reasons[input.category]?.includes(input.reason)) invalid(command);
  const detail: FailureDetail = { operation: command, kind: input.category as FailureKind, reason: input.reason as FailureReason,
    ...(input.category !== 'unknown' ? { transient: input.category === 'infrastructure' } : {}),
    exitCode: result.exitCode, commandStart: result.failure?.commandStart ?? 'unknown' };
  throw new PreflightError('COMMAND_FAILED', `${command} reported an execution failure; no code-repair authority`, detail);
}
