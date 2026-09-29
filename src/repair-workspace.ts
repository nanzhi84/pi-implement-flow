import { readFile } from 'node:fs/promises';
import { PreflightError } from './contract.ts';
import { captureCommand, git, run } from './process.ts';
import { canonicalMerge, type MergePreparation } from './merge-preparation.ts';
import { verifyEdit, type ImplementationEvidence, type MutationEvidence } from './mutation-evidence.ts';
import { commitParents, treeOf } from './code-proof.ts';
import { checkTicketWorkspace, commitTicket, type TicketWorkspace } from './ticket-workspace.ts';

export interface PreparedRepair { workspace: TicketWorkspace; preparation?: MergePreparation; startTree: string; }
export async function prepareRepair(workspace: TicketWorkspace, B: string, signal: AbortSignal, C?: string): Promise<PreparedRepair> {
  await checkTicketWorkspace(workspace);
  if ((await git(workspace.cwd, ['status', '--porcelain'], signal)).trim()) {
    throw new PreflightError('WORKSPACE_DRIFT', 'Repair requires the known clean and idle Ticket worktree; never discard existing work');
  }
  const ancestry = await captureCommand(['git', 'merge-base', '--is-ancestor', B, workspace.base], {
    cwd: workspace.cwd, signal, timeoutMs: 30_000, label: 'Repair accepted-base ancestry',
  });
  if (ancestry.exitCode === 0) return { workspace, startTree: await treeOf(workspace.cwd, workspace.base) };
  if (ancestry.exitCode !== 1) throw new PreflightError('MERGE_UNSUPPORTED', 'Could not establish accepted-base ancestry');
  const preparation = await canonicalMerge(workspace.cwd, workspace.base, B, signal);
  if (C && await treeOf(workspace.cwd, C) !== preparation.preparedTree) {
    throw new PreflightError('INTEGRATION_DRIFT', 'Recomputed merge tree differs from the actual GitHub candidate; preserve both versions');
  }
  const attributes = (await git(workspace.cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes'], signal)).trim();
  try { if ((await readFile(attributes)).length) throw new PreflightError('MERGE_UNSUPPORTED', 'Local info attributes are outside the controlled merge profile'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await git(workspace.cwd, ['-c', 'core.attributesFile=/dev/null', '-c', 'core.autocrlf=false', 'read-tree', '--reset', '-u', preparation.preparedTree], signal);
  await checkTicketWorkspace(workspace);
  if ((await git(workspace.cwd, ['write-tree'], signal)).trim() !== preparation.preparedTree
    || (await git(workspace.cwd, ['diff', '--name-only'], signal)).trim()) {
    throw new PreflightError('WORKSPACE_DRIFT', 'Materialized repair tree differs from its canonical preparation');
  }
  return { workspace, preparation, startTree: preparation.preparedTree };
}

export async function commitRepair(prepared: PreparedRepair, ticket: number, mutations: MutationEvidence[],
  proof: ImplementationEvidence, signal: AbortSignal): Promise<{ head: string; proof: ImplementationEvidence } | undefined> {
  const { workspace, preparation, startTree } = prepared;
  await checkTicketWorkspace(workspace);
  await git(workspace.cwd, ['add', '--all'], signal);
  const finalTree = (await git(workspace.cwd, ['write-tree'], signal)).trim();
  if (finalTree === startTree) return undefined;
  await verifyEdit(workspace.cwd, startTree, finalTree, mutations, finalTree);
  if (preparation) {
    for (const conflict of preparation.conflicts) {
      if (!mutations.some(event => event.path === conflict.path)) throw new PreflightError('MERGE_UNRESOLVED', 'Every text conflict must have an observed repair');
      const content = await run(['git', 'show', `${finalTree}:${conflict.path}`], { cwd: workspace.cwd, signal, timeoutMs: 30_000, label: 'Conflict marker verification' });
      if (content.includes(`<<<<<<< ${preparation.H}`) || content.includes(`>>>>>>> ${preparation.B}`)) {
        throw new PreflightError('MERGE_UNRESOLVED', 'Canonical text conflict markers remain; preserve work and do not push');
      }
    }
    const head = (await run(['git', 'commit-tree', finalTree, '-p', workspace.base, '-p', preparation.B, '-m', `Repair integration for Ticket #${ticket}`], {
      cwd: workspace.cwd, signal, timeoutMs: 30_000, label: 'Create controlled repair merge',
    })).trim();
    await git(workspace.cwd, ['update-ref', `refs/heads/${workspace.branch}`, head, workspace.base], signal);
    if (JSON.stringify(await commitParents(workspace.cwd, head)) !== JSON.stringify([workspace.base, preparation.B])) {
      throw new PreflightError('WORKSPACE_DRIFT', 'Repair merge did not preserve exact ordered parents');
    }
    return { head, proof: { ...proof, head, segments: [...proof.segments, { kind: 'controller-merge', from: workspace.base, head, preparation, resolutionMutations: mutations }] } };
  }
  const head = await commitTicket(workspace, ticket, signal);
  if (!head) return undefined;
  if (JSON.stringify(await commitParents(workspace.cwd, head)) !== JSON.stringify([workspace.base])) {
    throw new PreflightError('WORKSPACE_DRIFT', 'Repair edit must append exactly one parent');
  }
  return { head, proof: { ...proof, head, segments: [...proof.segments, { kind: 'agent-edit', from: workspace.base, head, mutations }] } };
}
