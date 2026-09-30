import { spawn } from 'node:child_process';
import { PreflightError } from './contract.ts';
import { classifyFailure, lifecycleFailure, type FailureDetail, type FailureOperation } from './failure.ts';

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  label: string;
  operation?: FailureOperation;
}
export interface CommandCapture { exitCode: number; stdout: Buffer; failure?: FailureDetail; }

// All consumers share one launch/lifecycle implementation. A completed numeric
// nonzero exit is parseable; cancellation, signal, timeout and orphaning are not.
export async function captureCommand(argv: string[], options: CommandOptions): Promise<CommandCapture> {
  options.signal?.throwIfAborted();
  const operation = options.operation ?? 'command';
  if (!argv[0] || process.platform === 'win32') throw new PreflightError('PLATFORM_UNSUPPORTED', 'POSIX command execution is required',
    { operation, kind: 'configuration', reason: 'unsupported-platform', transient: false, commandStart: 'not-started' });
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: { ...process.env, ...options.env },
        detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new PreflightError('COMMAND_FAILED', `${options.label} could not start; inspect the command privately`,
        { ...classifyFailure(operation, error), commandStart: 'not-started' }));
      return;
    }
    const output: Buffer[] = [];
    let diagnostic = Buffer.alloc(0);
    let bytes = 0;
    let failure: string | undefined;
    let startFailure: FailureDetail | undefined;
    let started = !!child.pid;
    let escalation: NodeJS.Timeout | undefined;
    const groupAlive = () => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = 'PROCESS_UNQUIESCED'; }
    };
    const stop = (reason: string) => {
      failure ??= reason;
      signalGroup('SIGTERM');
      escalation ??= setTimeout(() => signalGroup('SIGKILL'), 1000);
    };
    const abort = () => stop('COMMAND_CANCELLED');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => stop('COMMAND_TIMEOUT'), options.timeoutMs);
    child.once('spawn', () => { started = true; });
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) stop('COMMAND_OUTPUT_LIMIT'); else output.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (diagnostic.length < 16_384) diagnostic = Buffer.concat([diagnostic, chunk.subarray(0, 16_384 - diagnostic.length)]);
      if (bytes > 4 * 1024 * 1024) stop('COMMAND_OUTPUT_LIMIT');
    });
    child.once('error', error => { failure ??= 'COMMAND_FAILED'; startFailure = classifyFailure(operation, error); });
    child.once('exit', () => { if (groupAlive()) stop('COMMAND_ORPHANED'); });
    child.once('close', async (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (groupAlive()) {
        signalGroup('SIGKILL');
        await new Promise(resolve => setTimeout(resolve, 100));
        if (groupAlive()) failure = 'PROCESS_UNQUIESCED';
      }
      if (escalation) clearTimeout(escalation);
      const commandStart = started || !!child.pid ? 'started' : startFailure ? 'not-started' : 'unknown';
      const metadata = { commandStart, ...(Number.isInteger(code) ? { exitCode: code! } : {}), ...(signal ? { signal } : {}) } as const;
      if (failure || signal || !Number.isInteger(code)) {
        const detail = failure === 'COMMAND_FAILED' && startFailure ? startFailure : lifecycleFailure(operation, failure ?? 'COMMAND_FAILED');
        reject(new PreflightError(failure ?? 'COMMAND_FAILED', `${options.label} did not complete safely; inspect the command privately`, { ...detail, ...metadata }));
      } else {
        let detail = classifyFailure(operation, diagnostic.toString('utf8'));
        if (detail.reason === 'unclassified') detail = { ...detail, reason: 'process-exited' };
        resolve({ exitCode: code!, stdout: Buffer.concat(output), ...(code !== 0 ? { failure: { ...detail, ...metadata } } : {}) });
      }
    });
  });
}

export async function runBytes(argv: string[], options: CommandOptions): Promise<Buffer> {
  const result = await captureCommand(argv, options);
  if (result.exitCode !== 0) throw new PreflightError('COMMAND_FAILED', `${options.label} failed (exit ${result.exitCode}); inspect the command privately`, result.failure);
  return result.stdout;
}
export async function run(argv: string[], options: CommandOptions): Promise<string> {
  return (await runBytes(argv, options)).toString('utf8');
}
export function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return run(['git', ...args], { cwd, signal, timeoutMs: 30_000, label: `git ${args[0]}`,
    operation: ['push', 'commit', 'add', 'update-ref', 'merge', 'reset', 'cherry-pick'].includes(args[0] ?? '') ? 'git-write' : 'git-read' });
}
