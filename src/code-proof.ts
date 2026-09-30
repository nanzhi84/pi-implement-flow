import { PreflightError } from './contract.ts';
import { git, runBytes } from './process.ts';
import { createHash } from 'node:crypto';

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function invalidProof(): never {
  throw new PreflightError('IMPLEMENTATION_EVIDENCE_INVALID', 'Controlled code segments do not cover exact Git parents, modes and file bytes; preserve work and do not infer chronology');
}
export function validPath(path: string): boolean {
  return !!path && !path.includes('\0') && !path.includes('\\') && !path.startsWith('/')
    && !path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git');
}
export async function blob(cwd: string, treeish: string, path: string): Promise<{ mode: string; hash: string } | null> {
  if (!/^[a-f0-9]{40}$/.test(treeish) || !validPath(path)) invalidProof();
  const entries = (await git(cwd, ['ls-tree', '-z', treeish, '--', `:(literal)${path}`])).split('\0').filter(Boolean);
  if (!entries.length) return null;
  if (entries.length !== 1) invalidProof();
  const [identity, actualPath] = entries[0]!.split('\t');
  const [mode, kind, oid] = identity!.split(' ');
  if (actualPath !== path || !['100644', '100755'].includes(mode!) || kind !== 'blob' || !/^[a-f0-9]{40}$/.test(oid!)) invalidProof();
  return { mode: mode!, hash: sha256(await runBytes(['git', 'cat-file', 'blob', oid!], { cwd, timeoutMs: 30_000, label: 'Read proof blob' })) };
}
export async function commitParents(cwd: string, sha: string): Promise<string[]> {
  if (!/^[a-f0-9]{40}$/.test(sha)) invalidProof();
  const type = (await git(cwd, ['cat-file', '-t', sha])).trim();
  if (type !== 'commit') invalidProof();
  return (await git(cwd, ['show', '-s', '--format=%P', sha])).trim().split(' ').filter(Boolean);
}
export async function treeOf(cwd: string, sha: string): Promise<string> {
  return (await git(cwd, ['rev-parse', `${sha}^{tree}`])).trim();
}
