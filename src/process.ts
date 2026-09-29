import { spawn } from 'node:child_process';
import { PreflightError } from './contract.ts';

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  label: string;
}

// Trusted project commands are process-group scoped, not a credential/OS sandbox.
export async function runBytes(argv: string[], options: CommandOptions): Promise<Buffer> {
  options.signal?.throwIfAborted();
  if (!argv[0] || process.platform === 'win32') throw new PreflightError('PLATFORM_UNSUPPORTED', 'POSIX command execution is required');
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd, env: { ...process.env, ...options.env }, detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let bytes = 0;
    let failure: string | undefined;
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
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) stop('COMMAND_OUTPUT_LIMIT');
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) stop('COMMAND_OUTPUT_LIMIT');
    });
    child.on('error', () => { failure = 'COMMAND_FAILED'; });
    child.on('exit', () => {
      if (groupAlive()) stop('COMMAND_ORPHANED');
    });
    child.on('close', async code => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (groupAlive()) {
        signalGroup('SIGKILL');
        await new Promise(resolve => setTimeout(resolve, 100));
        if (groupAlive()) failure = 'PROCESS_UNQUIESCED';
      }
      if (escalation) clearTimeout(escalation);
      if (failure || code !== 0) reject(new PreflightError(failure ?? 'COMMAND_FAILED', `${options.label} failed (exit ${code ?? 'unknown'}); inspect the project command privately`));
      else resolve(Buffer.concat(output));
    });
  });
}

export async function run(argv: string[], options: CommandOptions): Promise<string> {
  return (await runBytes(argv, options)).toString('utf8');
}

export function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return run(['git', ...args], { cwd, signal, timeoutMs: 30_000, label: `git ${args[0]}` });
}
