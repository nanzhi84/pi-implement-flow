import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { PreflightError } from './contract.ts';
import { git } from './process.ts';

export interface MutationEvidence {
  order: number; path: string; beforeSha256: string | null; afterSha256: string;
}
export interface ImplementationEvidence { baseline: string; mutations: MutationEvidence[]; }
const execute = promisify(execFile);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function invalid(): never {
  throw new PreflightError('IMPLEMENTATION_EVIDENCE_INVALID', 'Controlled write evidence does not cover the actual baseline/head bytes; preserve work and do not infer chronology');
}

async function fileDigest(cwd: string, sha: string, path: string): Promise<string | null> {
  const entries = (await git(cwd, ['ls-tree', '-z', sha, '--', `:(literal)${path}`])).split('\0').filter(Boolean);
  if (!entries.length) return null;
  if (entries.length !== 1) invalid();
  const [identity, actualPath] = entries[0]!.split('\t');
  const [mode, kind, oid] = identity!.split(' ');
  if (actualPath !== path || !['100644', '100755'].includes(mode!) || kind !== 'blob' || !/^[a-f0-9]{40}$/.test(oid!)) invalid();
  try {
    const result = await execute('git', ['cat-file', 'blob', oid!], {
      cwd, encoding: 'buffer', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    return sha256(result.stdout);
  } catch { invalid(); }
}

// This is evidence for this implementation's delivered bytes, not a progress or
// operation ledger. It cannot authorize recovery, replay, or bypass a fresh gate.
export async function verifyMutationEvidence(cwd: string, proof: ImplementationEvidence | undefined,
  head: string, codeSha: string, scopeDigest: string) {
  if (!proof || !/^[a-f0-9]{40}$/.test(proof.baseline)) invalid();
  const paths = new Map<string, MutationEvidence[]>();
  for (const [index, event] of proof.mutations.entries()) {
    if (event.order !== index + 1 || !event.path || event.path.includes('\0') || event.path.includes('\\')
      || event.path.startsWith('/') || event.path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
      || (event.beforeSha256 !== null && !/^[a-f0-9]{64}$/.test(event.beforeSha256))
      || !/^[a-f0-9]{64}$/.test(event.afterSha256) || event.beforeSha256 === event.afterSha256) invalid();
    paths.set(event.path, [...(paths.get(event.path) ?? []), event]);
  }
  const changed = (await git(cwd, ['diff', '--name-only', '-z', '--no-renames', proof.baseline, head, '--'])).split('\0').filter(Boolean);
  if (changed.some(path => !paths.has(path))) invalid();
  const delivered = new Map<string, string | null>();
  for (const [path, events] of paths) {
    if (events[0]!.beforeSha256 !== await fileDigest(cwd, proof.baseline, path)) invalid();
    for (let index = 1; index < events.length; index += 1) {
      if (events[index]!.beforeSha256 !== events[index - 1]!.afterSha256) invalid();
    }
    if (events.at(-1)!.afterSha256 !== await fileDigest(cwd, head, path)) invalid();
    delivered.set(path, await fileDigest(cwd, codeSha, path));
  }
  return { source: 'controller-worktree-writes', baseline: proof.baseline, head, scopeDigest,
    boundary: 'Completed content-changing controlled write/edit operations only. Hashes prove byte order, not that a red test ran first or that arbitrary OS writes were audited. A final acceptance-file version must precede implementation changes to establish test-first; filenames alone do not establish it.',
    mutations: proof.mutations.map(event => ({ ...event, matchesDeliveredFile: delivered.get(event.path) === event.afterSha256 })) };
}
