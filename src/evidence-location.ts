import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PreflightError, type Contract } from './contract.ts';
import { Remote } from './remote.ts';
import { runBytes } from './process.ts';

export interface EvidenceLocation { tag: string; asset: string; url: string; }
export function evidencePath(resources: string, contract: Contract, legacyName: string): string {
  return join(resources, contract.artifacts.locator?.assetName ?? legacyName);
}
export function evidenceLocation(repository: string, contract: Contract, hash: string): EvidenceLocation | undefined {
  const locator = contract.artifacts.locator;
  if (!locator) return undefined;
  const tag = `${locator.tagPrefix}-${hash}`;
  return { tag, asset: locator.assetName, url: `https://github.com/${repository}/releases/download/${tag}/${locator.assetName}` };
}

interface GitObject { type: 'tag' | 'commit'; sha: string; }
function gitObject(value: unknown): GitObject {
  const item = value as GitObject | undefined;
  if (!item || !['tag', 'commit'].includes(item.type) || !/^[a-f0-9]{40}$/.test(item.sha)) {
    throw new PreflightError('EVIDENCE_INVALID', 'Artifact tag returned an unsupported Git object');
  }
  return { type: item.type, sha: item.sha };
}
export async function verifyLocatedEvidence(input: {
  cwd: string; repository: string; codeSha: string; hash: string; bytes: number;
  contract: Contract; location: EvidenceLocation;
}): Promise<void> {
  const { location, repository, codeSha } = input;
  const remote = new Remote(input.cwd, repository);
  const release = await remote.api<{ tag_name: string; draft: boolean; html_url: string;
    assets: { name: string; size: number; state: string; browser_download_url: string }[] }>(`releases/tags/${location.tag}`);
  if (!release || release.tag_name !== location.tag || release.draft !== false
    || release.html_url !== `https://github.com/${repository}/releases/tag/${location.tag}` || !Array.isArray(release.assets)) {
    throw new PreflightError('EVIDENCE_INVALID', 'Exact artifact release metadata does not match the approved locator');
  }
  const assets = release.assets.filter(item => item?.name === location.asset);
  if (assets.length === 0) throw new PreflightError('PUBLISH_UNRESOLVED', 'The exact release exists without a completed artifact; do not upload or replay publication');
  if (assets.length !== 1 || assets[0]!.state !== 'uploaded' || assets[0]!.size !== input.bytes || assets[0]!.browser_download_url !== location.url) {
    throw new PreflightError('EVIDENCE_INVALID', 'Exact artifact identity or byte length conflicts with the executed report');
  }
  const endpoint = `git/ref/tags/${location.tag}`;
  const reference = await remote.api<{ ref: string; object: unknown }>(endpoint);
  if (reference?.ref !== `refs/tags/${location.tag}`) throw new PreflightError('EVIDENCE_INVALID', 'Artifact Git ref identity differs');
  const initial = gitObject(reference.object); let current = initial;
  const seen = new Set<string>();
  for (let depth = 0; current.type === 'tag'; depth++) {
    if (depth >= 16 || seen.has(current.sha)) throw new PreflightError('EVIDENCE_INVALID', 'Artifact tag chain is cyclic or exceeds the supported object depth');
    seen.add(current.sha);
    const tag = await remote.api<{ sha: string; object: unknown }>(`git/tags/${current.sha}`);
    if (tag?.sha !== current.sha) throw new PreflightError('EVIDENCE_INVALID', 'Annotated tag identity differs');
    current = gitObject(tag.object);
  }
  if (current.sha !== codeSha) throw new PreflightError('EVIDENCE_INVALID', 'Actual Git tag does not resolve to the executed code version');
  const commit = await remote.api<{ sha: string }>(`git/commits/${codeSha}`);
  if (commit?.sha !== codeSha) throw new PreflightError('EVIDENCE_INVALID', 'Artifact commit identity is unverifiable');
  const bytes = await runBytes(['gh', 'release', 'download', location.tag, '--repo', repository, '--pattern', location.asset, '--output', '-'], {
    cwd: input.cwd, timeoutMs: input.contract.commandTimeoutMs, label: 'exact artifact download', operation: 'github-read',
  });
  if (createHash('sha256').update(bytes).digest('hex') !== input.hash) throw new PreflightError('EVIDENCE_INVALID', 'Raw artifact bytes differ from the executed report');
  const final = await remote.api<{ ref: string; object: unknown }>(endpoint);
  if (final?.ref !== reference.ref || JSON.stringify(gitObject(final.object)) !== JSON.stringify(initial)) {
    throw new PreflightError('EVIDENCE_INVALID', 'Artifact tag changed while downloading its evidence');
  }
}
