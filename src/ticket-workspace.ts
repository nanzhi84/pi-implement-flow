import { mkdir, readdir, lstat, readFile, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PreflightError } from './contract.ts';
import { git } from './process.ts';

export async function remoteHead(cwd: string, branch: string): Promise<string | undefined> {
  const output = await git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  return output.trim().split(/\s+/)[0] || undefined;
}
export async function requireRemoteHead(cwd: string, branch: string, expected: string): Promise<void> {
  if (await remoteHead(cwd, branch) !== expected) throw new PreflightError('REMOTE_DRIFT', `Remote ${branch} changed; preserve work and reconcile, never overwrite`);
}
export async function pushNew(cwd: string, sha: string, branch: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (await remoteHead(cwd, branch)) throw new PreflightError('BRANCH_EXISTS', `Remote ${branch} exists; reconciliation required`);
  signal.throwIfAborted();
  // Empty expected value is an atomic create-only condition, never an overwrite.
  try { await git(cwd, ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:`, 'origin', `${sha}:refs/heads/${branch}`]); }
  catch (error) {
    if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
    throw new PreflightError('REMOTE_RESULT_UNKNOWN', `Push to ${branch} has unknown outcome; preserve local commit and inspect remote before retrying`, error instanceof PreflightError ? error.detail : undefined);
  }
  await requireRemoteHead(cwd, branch, sha);
  signal.throwIfAborted();
}

export interface TicketWorkspace { cwd: string; resources: string; branch: string; base: string; }
export async function createTicketWorkspace(cwd: string, spec: number, ticket: number, base: string, signal: AbortSignal): Promise<TicketWorkspace> {
  const common = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).trim();
  const parent = join(common, 'flow-tickets', `spec-${spec}`);
  await mkdir(parent, { recursive: true });
  const name = `ticket-${ticket}`;
  if ((await readdir(parent)).includes(name)) throw new PreflightError('RECOVERY_REQUIRED', 'Ticket workspace exists; preserve and reconcile local work and processes');
  const root = join(parent, name);
  await mkdir(root); // Exclusive name, never reuse an unknown writer's workspace.
  const workspace = join(root, 'worktree');
  const resources = join(root, 'resources');
  await mkdir(resources);
  const branch = `flow/ticket-${spec}-${ticket}`;
  await git(cwd, ['worktree', 'add', '-b', branch, workspace, base], signal);
  return { cwd: workspace, resources, branch, base };
}

export async function checkTicketWorkspace(workspace: TicketWorkspace): Promise<void> {
  if ((await git(workspace.cwd, ['symbolic-ref', '--short', 'HEAD'])).trim() !== workspace.branch
    || (await git(workspace.cwd, ['rev-parse', 'HEAD'])).trim() !== workspace.base) {
    throw new PreflightError('WORKSPACE_DRIFT', 'Agent changed Git branch/history; preserve workspace and refuse delivery');
  }
}

// Hash source, untracked additions, modes and symlink targets without following
// links. Cleanup may release resources, but must not become another code writer.
export async function workingTreeDigest(cwd: string): Promise<string> {
  const paths = [...new Set((await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path).update('\0');
    try {
      const file = join(cwd, path);
      const info = await lstat(file);
      hash.update(String(info.mode)).update('\0');
      if (info.isSymbolicLink()) hash.update(await readlink(file));
      else if (info.isFile()) hash.update(await readFile(file));
      else hash.update('non-file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('deleted');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function commitTicket(workspace: TicketWorkspace, ticket: number, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  await checkTicketWorkspace(workspace);
  if (!(await git(workspace.cwd, ['status', '--porcelain'])).trim()) return undefined;
  await git(workspace.cwd, ['add', '--all'], signal);
  await git(workspace.cwd, ['commit', '-m', `Implement Ticket #${ticket}`], signal);
  const sha = (await git(workspace.cwd, ['rev-parse', 'HEAD'], signal)).trim();
  if ((await git(workspace.cwd, ['rev-parse', 'HEAD^'], signal)).trim() !== workspace.base
    || (await git(workspace.cwd, ['status', '--porcelain'], signal)).trim()) {
    throw new PreflightError('WORKSPACE_DRIFT', 'Ticket commit does not preserve the expected baseline or clean workspace');
  }
  return sha;
}
