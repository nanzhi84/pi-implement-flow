import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [mode, key, command, ...args] = process.argv.slice(2);
if (!mode || !key || !command) process.exit(97);
const run = (cmd, argv) => spawnSync(cmd, argv, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const applied = fact => process.stderr.write(`RECONCILIATION_APPLIED: ${JSON.stringify({ key, ...fact })}\n`);
if (mode === 'read-unavailable') {
  process.stderr.write('Controlled query unavailable after uncertain write\n'); process.exit(1);
}
if (['publisher-partial', 'publisher-bytes-mismatch', 'publisher-wrong-tag'].includes(mode)) {
  const { FLOW_REPOSITORY: repo, FLOW_ARTIFACT_TAG: tag, FLOW_ARTIFACT_NAME: name, FLOW_CODE_SHA: sha } = process.env;
  if (repo !== 'nanzhi84/pi-implement-flow-reconciliation-acceptance'
    || !/^flow-evidence-[a-f0-9]{64}$/.test(tag ?? '') || name !== 'evidence.json' || !/^[a-f0-9]{40}$/.test(sha ?? '')) process.exit(97);
  const created = run('gh', ['release', 'create', tag, '--repo', repo, '--target', mode === 'publisher-wrong-tag' ? '485b0ddfecbfed0fc6248fdad63454c792902f03' : sha, '--prerelease', '--latest=false',
    '--title', 'Synthetic partial publication', '--notes', 'Synthetic fault evidence; retain 90 days.']);
  if (created.status !== 0 || created.error || created.signal) process.exit(98);
  if (mode !== 'publisher-partial') {
    const directory = mkdtempSync(join(tmpdir(), 'flow-wrong-asset-'));
    try {
      const file = join(directory, name); const bytes = readFileSync(process.env.FLOW_REPORT);
      if (mode === 'publisher-bytes-mismatch') {
        if (bytes.at(-1) !== 10) process.exit(97);
        bytes[bytes.length - 1] = 32; // Equal length and JSON value, different actual bytes.
      }
      writeFileSync(file, bytes);
      const uploaded = run('gh', ['release', 'upload', tag, file, '--repo', repo]);
      if (uploaded.status !== 0 || uploaded.error || uploaded.signal) process.exit(98);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  applied({ tag, assetCreated: mode !== 'publisher-partial' }); process.exit(1);
}
if (!['lose-response', 'publisher-source-drift', 'read-orphaned', 'derived-association-drift', 'push-read-not-started'].includes(mode)) process.exit(97);
const result = run(command, args);
if (result.error || result.signal || result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status || 98);
}
if (mode === 'read-orphaned') {
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.stdout.write(result.stdout); process.exit(0);
}
if (mode === 'publisher-source-drift') {
  appendFileSync('app.mjs', '\n// Synthetic publisher source drift.\n');
  applied({ tag: process.env.FLOW_ARTIFACT_TAG, assetCreated: true });
  process.stdout.write(result.stdout); process.exit(0);
}
let fact = {};
try {
  const value = JSON.parse(result.stdout);
  if (Number.isSafeInteger(value?.number)) fact.number = value.number;
  if (/^[a-f0-9]{40}$/.test(value?.sha ?? '')) fact.sha = value.sha;
} catch { /* A successful CLI need not return JSON. */ }
if (mode === 'derived-association-drift') {
  const repo = 'nanzhi84/pi-implement-flow-reconciliation-acceptance';
  const created = JSON.parse(result.stdout);
  if (!Number.isSafeInteger(created.number) || created.number < 1 || created.html_url !== `https://github.com/${repo}/issues/${created.number}`) process.exit(97);
  const changed = run('gh', ['api', `repos/${repo}/issues/${created.number}`, '--method', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=not_planned']);
  if (changed.status !== 0 || JSON.parse(changed.stdout).state !== 'closed') process.exit(98);
  fact.number = created.number;
}
applied(fact);
if (mode === 'push-read-not-started') { process.stdout.write(result.stdout); process.exit(0); }
process.stderr.write('Controlled response lost after the real remote command completed\n');
process.exit(1);
