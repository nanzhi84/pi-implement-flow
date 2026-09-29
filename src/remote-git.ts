import { PreflightError } from './contract.ts';
import { git } from './process.ts';
import { cannotReconcile, unknownWrite } from './remote-error.ts';

export async function remoteHead(cwd: string, branch: string): Promise<string | undefined> {
  await git(cwd, ['check-ref-format', `refs/heads/${branch}`]);
  const output = (await git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])).trim();
  if (!output) return undefined;
  const [sha, ref, ...rest] = output.split(/\s+/);
  if (!sha || !/^[a-f0-9]{40}$/.test(sha) || ref !== `refs/heads/${branch}` || rest.length) {
    throw new PreflightError('REMOTE_INVALID', 'The exact remote branch did not return one valid version');
  }
  return sha;
}
export async function requireRemoteHead(cwd: string, branch: string, expected: string): Promise<void> {
  if (await remoteHead(cwd, branch) !== expected) throw new PreflightError('REMOTE_DRIFT', 'Remote branch changed; preserve work and never overwrite it');
}

// A create-only or expected-old-head update. At most one push is sent by this
// invocation. Readback after an uncertain result never creates a retry loop.
export async function pushExpected(cwd: string, sha: string, branch: string, expected: string | undefined, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!/^[a-f0-9]{40}$/.test(sha) || (expected !== undefined && !/^[a-f0-9]{40}$/.test(expected))) {
    throw new PreflightError('VERSION_INVALID', 'Push requires exact local and remote versions');
  }
  const before = await remoteHead(cwd, branch);
  signal.throwIfAborted();
  if (before === sha) return; // Exact existing outcome; no write is necessary.
  if (before !== expected) throw new PreflightError('REMOTE_DRIFT', 'Remote branch does not match the expected pre-write state');
  if (expected) await git(cwd, ['merge-base', '--is-ancestor', expected, sha], signal);
  signal.throwIfAborted();
  let failure: unknown;
  try { await git(cwd, ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${expected ?? ''}`, 'origin', `${sha}:refs/heads/${branch}`]); }
  catch (error) { failure = unknownWrite(error, 'Push outcome is unknown; retain the local commit and exact target', true); cannotReconcile(failure, signal, true); }
  try {
    if (await remoteHead(cwd, branch) !== sha) throw new Error('Exact target not confirmed');
  } catch (error) {
    cannotReconcile(error, signal, true);
    throw unknownWrite(failure ?? error, 'Push readback did not confirm the exact target SHA; absence or the old ref is not proof of non-application; no replay');
  }
  signal.throwIfAborted();
}
