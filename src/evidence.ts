import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { PreflightError, type Contract } from './contract.ts';
import { runBytes } from './process.ts';

export interface Evidence { url: string; sha256: string; codeSha: string; }

// Publishing is a trusted project operation. A failed write is never replayed here.
export async function publishEvidence(input: {
  cwd: string; repository: string; codeSha: string; contract: Contract;
  path: string; report: unknown; publish(): Promise<string>; signal?: AbortSignal; beforePublish?(): void;
}): Promise<Evidence> {
  const content = JSON.stringify(input.report, null, 2) + '\n';
  const hash = createHash('sha256').update(content).digest('hex');
  await writeFile(input.path, content, { mode: 0o600 });
  input.signal?.throwIfAborted();
  // This check is outside the unknown-write catch: no publication was launched.
  input.beforePublish?.();
  let publication: { url?: unknown; sha256?: unknown; retentionDays?: unknown };
  try { publication = JSON.parse(await input.publish()); }
  catch (error) {
    if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
    throw new PreflightError('PUBLISH_UNRESOLVED', 'Publisher outcome is unknown; retain the report and reconcile the exact remote evidence before continuing', error instanceof PreflightError ? error.detail : undefined);
  }
  const pattern = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
  const link = publication && typeof publication.url === 'string' ? pattern.exec(publication.url) : null;
  if (!link || link[1]?.toLowerCase() !== input.repository.toLowerCase() || publication.sha256 !== hash
    || typeof publication.retentionDays !== 'number' || publication.retentionDays < input.contract.artifacts.retentionDays) {
    throw new PreflightError('EVIDENCE_INVALID', 'Evidence must be a same-repository release asset with matching SHA256 and sufficient retention');
  }
  const bytes = await runBytes(['gh', 'release', 'download', link[2]!, '--repo', input.repository, '--pattern', link[3]!, '--output', '-'], {
    cwd: input.cwd, signal: input.signal, timeoutMs: input.contract.commandTimeoutMs, label: 'evidence download', operation: 'github-read',
  });
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new PreflightError('EVIDENCE_INVALID', 'Downloaded evidence bytes do not match the executed report');
  return { url: publication.url as string, sha256: hash, codeSha: input.codeSha };
}
