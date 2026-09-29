import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { PreflightError, type Contract } from './contract.ts';
import { runBytes } from './process.ts';
import { evidenceLocation, verifyLocatedEvidence } from './evidence-location.ts';
import { unknownWrite } from './remote-error.ts';

export interface Evidence { url: string; sha256: string; codeSha: string; }

// Publishing is a trusted project operation. A failed write is never replayed here.
export async function publishEvidence(input: {
  cwd: string; repository: string; codeSha: string; contract: Contract;
  path: string; report: unknown; publish(environment: NodeJS.ProcessEnv): Promise<string>; signal?: AbortSignal; beforePublish?(): void;
}): Promise<Evidence> {
  const content = JSON.stringify(input.report, null, 2) + '\n';
  const hash = createHash('sha256').update(content).digest('hex');
  const location = evidenceLocation(input.repository, input.contract, hash);
  if (location && basename(input.path) !== location.asset) throw new PreflightError('EVIDENCE_INVALID', 'FLOW_REPORT basename must be the approved artifact name');
  const environment = location ? { FLOW_ARTIFACT_SHA256: hash, FLOW_ARTIFACT_TAG: location.tag,
    FLOW_ARTIFACT_NAME: location.asset, FLOW_ARTIFACT_URL: location.url,
    FLOW_ARTIFACT_RETENTION_DAYS: String(input.contract.artifacts.retentionDays) } : {};
  await writeFile(input.path, content, { mode: 0o600 });
  input.signal?.throwIfAborted();
  // This check is outside the unknown-write catch: no publication was launched.
  input.beforePublish?.();
  let publication: { url?: unknown; sha256?: unknown; retentionDays?: unknown } | undefined;
  let publisherFailure: unknown;
  try { publication = JSON.parse(await input.publish(environment)); }
  catch (error) {
    // Only a publisher command result or its lost/invalid JSON can be
    // reconciled. Workspace, scope and lifecycle failures remain authoritative.
    if (error instanceof PreflightError) {
      if (error.code === 'COMMAND_ORPHANED') throw new PreflightError('PUBLISH_UNRESOLVED',
        'COMMAND_ORPHANED interrupted publication; preserve ownership without another query or publisher invocation', error.detail);
      if (!['COMMAND_FAILED', 'COMMAND_TIMEOUT', 'COMMAND_CANCELLED', 'COMMAND_OUTPUT_LIMIT'].includes(error.code)) throw error;
      if (error.detail?.commandStart === 'not-started') throw unknownWrite(error, 'Publisher command did not start', true);
    } else if (!(error instanceof SyntaxError)) throw error;
    publisherFailure = error;
    if (!location) throw new PreflightError('PUBLISH_UNRESOLVED', 'Publisher outcome is unknown without an approved locator; retain the report without replay', error instanceof PreflightError ? error.detail : undefined);
  }
  if (location) {
    if (!publisherFailure && (!publication || publication.url !== location.url || publication.sha256 !== hash
      || typeof publication.retentionDays !== 'number' || publication.retentionDays < input.contract.artifacts.retentionDays)) {
      throw new PreflightError('EVIDENCE_INVALID', 'Publisher response differs from the approved exact artifact or retention commitment');
    }
    try { await verifyLocatedEvidence({ ...input, location, hash, bytes: Buffer.byteLength(content) }); }
    catch (error) {
      if (error instanceof PreflightError && ['PROCESS_UNQUIESCED', 'EVIDENCE_INVALID', 'PUBLISH_UNRESOLVED'].includes(error.code)) throw error;
      throw new PreflightError('PUBLISH_UNRESOLVED', error instanceof PreflightError && error.code === 'COMMAND_ORPHANED'
        ? 'COMMAND_ORPHANED interrupted artifact readback; preserve ownership without another query or publisher invocation'
        : 'Exact artifact readback is unavailable; no repeated publisher invocation', error instanceof PreflightError ? error.detail : undefined);
    }
    return { url: location.url, sha256: hash, codeSha: input.codeSha };
  }
  const pattern = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
  const link = publication && typeof publication.url === 'string' ? pattern.exec(publication.url) : null;
  if (!publication || !link || link[1]?.toLowerCase() !== input.repository.toLowerCase() || publication.sha256 !== hash
    || typeof publication.retentionDays !== 'number' || publication.retentionDays < input.contract.artifacts.retentionDays) {
    throw new PreflightError('EVIDENCE_INVALID', 'Evidence must be a same-repository release asset with matching SHA256 and sufficient retention');
  }
  const bytes = await runBytes(['gh', 'release', 'download', link[2]!, '--repo', input.repository, '--pattern', link[3]!, '--output', '-'], {
    cwd: input.cwd, signal: input.signal, timeoutMs: input.contract.commandTimeoutMs, label: 'evidence download', operation: 'github-read',
  });
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new PreflightError('EVIDENCE_INVALID', 'Downloaded evidence bytes do not match the executed report');
  return { url: publication.url as string, sha256: hash, codeSha: input.codeSha };
}
