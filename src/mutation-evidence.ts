import { git } from './process.ts';
import { blob, commitParents, invalidProof, validPath } from './code-proof.ts';
import { canonicalMerge, type MergePreparation } from './merge-preparation.ts';

export interface MutationEvidence { order: number; path: string; beforeSha256: string | null; afterSha256: string; }
export interface EditSegment { kind: 'agent-edit'; from: string; head: string; mutations: MutationEvidence[]; }
export interface MergeSegment {
  kind: 'controller-merge'; from: string; head: string; preparation: MergePreparation; resolutionMutations: MutationEvidence[];
}
export interface ImplementationEvidence {
  schema: 2; source: 'controller-code-segments'; origin: string; head: string; segments: (EditSegment | MergeSegment)[];
}

// Every effective file change is attributed to observed tools. Mode, deletion,
// symlink and gitlink changes are not supported by that tool protocol.
export async function verifyEdit(cwd: string, from: string, head: string, mutations: MutationEvidence[], codeSha: string) {
  const paths = new Map<string, MutationEvidence[]>();
  for (const [index, event] of mutations.entries()) {
    if (event.order !== index + 1 || !validPath(event.path)
      || (event.beforeSha256 !== null && !/^[a-f0-9]{64}$/.test(event.beforeSha256))
      || !/^[a-f0-9]{64}$/.test(event.afterSha256) || event.beforeSha256 === event.afterSha256) invalidProof();
    paths.set(event.path, [...(paths.get(event.path) ?? []), event]);
  }
  const changed = (await git(cwd, ['diff', '--name-only', '-z', '--no-renames', from, head, '--'])).split('\0').filter(Boolean);
  if (changed.some(path => !paths.has(path))) invalidProof();
  const delivered = new Map<string, string | null>();
  for (const [path, events] of paths) {
    const initial = await blob(cwd, from, path); const final = await blob(cwd, head, path);
    if (!final || final.mode !== (initial?.mode ?? '100644') || events[0]!.beforeSha256 !== (initial?.hash ?? null)) invalidProof();
    for (let index = 1; index < events.length; index += 1) {
      if (events[index]!.beforeSha256 !== events[index - 1]!.afterSha256) invalidProof();
    }
    if (events.at(-1)!.afterSha256 !== final.hash) invalidProof();
    delivered.set(path, (await blob(cwd, codeSha, path))?.hash ?? null);
  }
  return mutations.map(event => ({ ...event, matchesDeliveredFile: delivered.get(event.path) === event.afterSha256 }));
}

// This proof is code provenance, never an operation ledger or a gate waiver.
export async function verifyMutationEvidence(cwd: string, proof: ImplementationEvidence | undefined,
  head: string, codeSha: string, scopeDigest: string) {
  if (!proof || proof.schema !== 2 || proof.source !== 'controller-code-segments'
    || !/^[a-f0-9]{40}$/.test(proof.origin) || proof.head !== head || !proof.segments.length) invalidProof();
  let previous = proof.origin;
  const segments = [];
  for (const segment of proof.segments) {
    if (segment.from !== previous) invalidProof();
    const parents = await commitParents(cwd, segment.head);
    if (segment.kind === 'agent-edit') {
      if (JSON.stringify(parents) !== JSON.stringify([segment.from])) invalidProof();
      segments.push({ ...segment, mutations: await verifyEdit(cwd, segment.from, segment.head, segment.mutations, codeSha) });
    } else if (segment.kind === 'controller-merge') {
      if (segment.preparation.H !== segment.from || JSON.stringify(parents) !== JSON.stringify([segment.from, segment.preparation.B])) invalidProof();
      const canonical = await canonicalMerge(cwd, segment.from, segment.preparation.B);
      if (JSON.stringify(canonical) !== JSON.stringify(segment.preparation)) invalidProof();
      segments.push({ ...segment, resolutionMutations: await verifyEdit(cwd, canonical.preparedTree, segment.head, segment.resolutionMutations, codeSha) });
    } else invalidProof();
    previous = segment.head;
  }
  if (previous !== head) invalidProof();
  return { ...proof, scopeDigest, segments,
    boundary: 'Continuous Git-parent segments distinguish controller merge preparation from completed Agent write/edit operations. Per-segment hashes prove byte order, not that a red test ran first. Every effective Agent file change and mode is checked; all controller merges are independently reproducible.' };
}
