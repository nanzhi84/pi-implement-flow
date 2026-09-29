import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PreflightError } from './contract.ts';
import { captureCommand, git, run } from './process.ts';
import { commitParents, validPath } from './code-proof.ts';

export interface MergePreparation {
  H: string; B: string; mergeBases: string[];
  profile: { kind: 'builtin-ort-v1'; gitVersion: string };
  preparedTree: string;
  conflicts: { path: string; stages: { stage: 1 | 2 | 3; mode: string; oid: string }[] }[];
}
function unsupported(): never {
  throw new PreflightError('MERGE_UNSUPPORTED', 'Controlled merge supports ordinary text content conflicts only; preserve inputs and request a decision for attributes, binary, mode, rename or deletion conflicts');
}
async function supportedTree(cwd: string, sha: string) {
  for (const entry of (await git(cwd, ['ls-tree', '-r', '-z', sha])).split('\0').filter(Boolean)) {
    const [identity, path] = entry.split('\t');
    const [mode, kind] = identity!.split(' ');
    if (!path || !validPath(path) || !['100644', '100755'].includes(mode!) || kind !== 'blob'
      || path.split('/').some(part => ['.gitattributes', '.gitmodules'].includes(part))) unsupported();
  }
}

// Compute in a config-free bare repository sharing only immutable Git objects.
// No worktree/global/info attributes, custom drivers, filters, hooks or rerere
// participate. The SHA-labelled marker bytes are part of the resulting tree.
export async function canonicalMerge(cwd: string, H: string, B: string, signal?: AbortSignal): Promise<MergePreparation> {
  await commitParents(cwd, H); await commitParents(cwd, B);
  const mergeBases = (await git(cwd, ['merge-base', '--all', H, B], signal)).trim().split('\n').sort();
  if (!mergeBases.length || mergeBases.some(sha => !/^[a-f0-9]{40}$/.test(sha))) unsupported();
  for (const sha of [H, B, ...mergeBases]) await supportedTree(cwd, sha);
  const objects = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], signal)).trim();
  const bare = await mkdtemp(join(tmpdir(), 'flow-merge-'));
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('GIT_')).map(key => [key, undefined])),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
    GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OBJECT_DIRECTORY: objects,
  };
  const options = { cwd: bare, env, signal, timeoutMs: 30_000, label: 'Controlled merge preparation' };
  try {
    await run(['git', 'init', '--bare', '--template=', '.'], options);
    const gitVersion = (await run(['git', '--version'], options)).trim();
    const result = await captureCommand(['git', '-c', 'merge.conflictStyle=merge', '-c', 'merge.renormalize=false',
      'merge-tree', '--write-tree', '--messages', '-z', H, B], options);
    if (result.exitCode !== 0 && result.exitCode !== 1) unsupported();
    const source = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
    const fields = source.split('\0'); const preparedTree = fields.shift()!;
    if (!/^[a-f0-9]{40}$/.test(preparedTree)) unsupported();
    const conflicts = new Map<string, MergePreparation['conflicts'][number]['stages']>();
    let field: string | undefined;
    while ((field = fields.shift())) {
      const match = /^(100644|100755) ([a-f0-9]{40}) ([123])\t(.+)$/.exec(field);
      if (!match || !validPath(match[4]!)) unsupported();
      conflicts.set(match[4]!, [...(conflicts.get(match[4]!) ?? []), { stage: Number(match[3]) as 1 | 2 | 3, mode: match[1]!, oid: match[2]! }]);
    }
    // Remaining records are structured messages: path-count, paths, type, text.
    while (fields.length && fields[0]) {
      const count = Number(fields.shift());
      if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) unsupported();
      const paths = fields.splice(0, count); const kind = fields.shift(); fields.shift();
      if (paths.some(path => !validPath(path)) || !['Auto-merging', 'CONFLICT (contents)'].includes(kind!)) unsupported();
    }
    const rows = [...conflicts].sort(([a], [b]) => a.localeCompare(b)).map(([path, stages]) => ({ path, stages: stages.sort((a, b) => a.stage - b.stage) }));
    if ((result.exitCode === 1) !== !!rows.length) unsupported();
    for (const row of rows) {
      if (row.stages.length !== 3 || row.stages.some((stage, index) => stage.stage !== index + 1 || stage.mode !== row.stages[0]!.mode)) unsupported();
    }
    await supportedTree(cwd, preparedTree);
    return { H, B, mergeBases, profile: { kind: 'builtin-ort-v1', gitVersion }, preparedTree, conflicts: rows };
  } finally { await rm(bare, { recursive: true, force: true }); }
}
