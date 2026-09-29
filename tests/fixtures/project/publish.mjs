import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

// Project-owned publisher. Content-addressed remote identity, never blind retries.
const repository = process.env.FLOW_REPOSITORY;
const sha = process.env.FLOW_CODE_SHA;
const report = process.env.FLOW_REPORT;
if (!repository || !sha || !report) throw new Error('Publishing environment incomplete');
const content = await readFile(report);
const digest = createHash('sha256').update(content).digest('hex');
const tag = `flow-evidence-${digest}`;
const filename = basename(report);
if (!/^[A-Za-z0-9._-]+$/.test(filename)) throw new Error('Unsafe evidence asset name');
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function release() {
  try { return JSON.parse(gh(['api', `repos/${repository}/releases/tags/${tag}`])); }
  catch (error) {
    let status;
    try { status = JSON.parse(error.stdout).status; } catch { /* unknown; fail closed */ }
    if (String(status) === '404') return undefined;
    throw new Error('Release lookup failed; no replay');
  }
}
let remote = release();
if (!remote) {
  try {
    gh(['release', 'create', tag, '--repo', repository, '--target', sha, '--prerelease',
      '--title', 'Isolated preflight evidence', '--notes', 'Synthetic data; retain at least 90 days and while review remains open.']);
  } catch { /* reconcile this exact tag, whether the write succeeded or was unknown */ }
  remote = release();
  if (!remote) throw new Error('Release creation unresolved; stop without retry');
}
if (remote.target_commitish !== sha) throw new Error('Release version mismatch');
if (!remote.assets.some(asset => asset.name === filename)) {
  try { gh(['release', 'upload', tag, report, '--repo', repository]); }
  catch { /* reconcile the exact content-addressed asset, never overwrite or retry */ }
}
const fetched = gh(['release', 'download', tag, '--repo', repository, '--pattern', filename, '--output', '-']);
if (createHash('sha256').update(fetched).digest('hex') !== digest) throw new Error('Published bytes mismatch');
process.stdout.write(JSON.stringify({
  url: `https://github.com/${repository}/releases/download/${tag}/${filename}`,
  sha256: digest,
  retentionDays: 90,
}) + '\n');
