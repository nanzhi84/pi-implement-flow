import { mkdir, readdir, lstat, readFile, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PreflightError } from './contract.ts';
import { git } from './process.ts';

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
