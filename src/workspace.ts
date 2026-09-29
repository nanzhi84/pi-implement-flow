import { mkdtemp, mkdir, realpath, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PreflightError } from './contract.ts';
import { git } from './process.ts';

export async function baseline(cwd: string, feature: string, signal: AbortSignal): Promise<string> {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'], signal)).trim();
    if (await realpath(cwd) !== await realpath(root)) throw new PreflightError('PROJECT_UNPREPARED', 'Start flow at the repository root');
    if ((await git(cwd, ['status', '--porcelain'], signal)).trim()) throw new PreflightError('PROJECT_UNPREPARED', 'Uncommitted files must be preserved and reconciled before start');
    const common = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).trim();
    if ((await readdir(common)).some(name => name.startsWith('flow-probe-'))) throw new PreflightError('RECOVERY_REQUIRED', 'Existing probe workspaces need explicit reconciliation; no automatic deletion or replay');
    const sha = (await git(cwd, ['rev-parse', 'HEAD'], signal)).trim();
    let refs: string;
    try { refs = await git(cwd, ['ls-remote', '--heads', 'origin', 'refs/heads/main', `refs/heads/${feature}`], signal); }
    catch (error) {
      if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
      signal.throwIfAborted();
      throw new PreflightError('REMOTE_READ_FAILED', 'Cannot read remote Git baseline; diagnose transport or authentication before another attempt');
    }
    const lines = refs.trim().split('\n').map(line => line.split(/\s+/));
    if (lines.some(line => line[1] === `refs/heads/${feature}`)) throw new PreflightError('FLOW_EXISTS', 'Remote feature branch already exists; reconcile and resume rather than starting another flow');
    const main = lines.find(line => line[1] === 'refs/heads/main')?.[0];
    if (!main || main !== sha) throw new PreflightError('PROJECT_UNPREPARED', 'Local HEAD must match remote main; preserve and reconcile local work before start');
    return sha;
  } catch (error) {
    if (error instanceof PreflightError && error.code !== 'COMMAND_FAILED') throw error;
    throw new PreflightError('PROJECT_UNPREPARED', 'Need a clean committed project at remote main, readable origin and available Git');
  }
}

export interface ProbeWorkspace {
  cwd: string;
  resources: string;
  check(): Promise<void>;
  remove(): Promise<void>;
}
export async function createProbe(cwd: string, sha: string, signal: AbortSignal): Promise<ProbeWorkspace> {
  const common = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).trim();
  const root = await mkdtemp(join(common, 'flow-probe-'));
  const workspace = join(root, 'worktree');
  const resources = join(root, 'resources');
  await mkdir(resources);
  try { await git(cwd, ['worktree', 'add', '--detach', workspace, sha], signal); }
  catch (error) {
    if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
    // git may have registered a partial worktree. Preserve it, never force a cleanup guess.
    throw new PreflightError('WORKSPACE_UNRESOLVED', 'Probe worktree creation failed; preserve the flow-probe directory and inspect git worktree list');
  }
  const check = async () => {
    if ((await git(workspace, ['rev-parse', 'HEAD'])).trim() !== sha) throw new PreflightError('PROBE_VERSION_CHANGED', 'Probe HEAD differs from the approved SHA; preserve the worktree; no publication or startup');
    if ((await git(workspace, ['status', '--porcelain'])).trim()) throw new PreflightError('PROBE_CHANGED_CODE', 'Project probes changed code; preserve the detached worktree and inspect it');
  };
  return {
    cwd: workspace, resources, check,
    async remove() {
      await check();
      await git(cwd, ['worktree', 'remove', workspace]);
      await rm(root, { recursive: true }); // Only the exclusively created, non-user probe directory.
    },
  };
}
