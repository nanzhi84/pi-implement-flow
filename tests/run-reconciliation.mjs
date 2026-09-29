import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const names = ['applied-responses-lost', 'push-not-sent', 'push-read-not-started', 'pr-read-unavailable', 'pr-read-orphaned', 'merge-read-unavailable',
  'publisher-partial', 'publisher-bytes-mismatch', 'publisher-source-drift', 'publisher-wrong-tag', 'derived-association-lost', 'derived-association-drift', 'derived-create-unresolved'];
const selected = process.env.FLOW_RECONCILIATION_SCENARIO;
if (selected && !names.includes(selected)) throw new Error('Unknown selected reconciliation scenario');
const expected = process.env.RUN_GITHUB_E2E === '1' ? selected ? [selected] : names : [];
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function source() {
  const paths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of new Set(paths)) {
    hash.update(path + '\0');
    try {
      const item = await lstat(path); hash.update(String(item.mode) + '\0');
      hash.update(item.isSymbolicLink() ? await readlink(path) : await readFile(path));
    } catch (error) { if (error.code !== 'ENOENT') throw error; hash.update('missing'); }
    hash.update('\0');
  }
  return { sha: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain']), digest: hash.digest('hex') };
}
const initial = await source(); const startedAt = new Date().toISOString();
await mkdir('artifacts/reconciliation-runs', { recursive: true });
await rm('artifacts/reconciliation-scenarios.json', { force: true });
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/reconciliation.test.mjs'], {
  stdio: 'inherit', env: { ...process.env, FLOW_EXECUTION_ARTIFACT_PREFIX: 'reconciliation' },
});
const testRunner = await new Promise(resolve => {
  child.once('error', () => resolve({ exitCode: null, signal: null, spawnError: true }));
  child.once('exit', (exitCode, signal) => resolve({ exitCode, signal, spawnError: false }));
});
const final = await source(); let data = { results: [], created: [] };
try { data = JSON.parse(await readFile('artifacts/reconciliation-scenarios.json', 'utf8')); } catch { /* Missing rows cannot pass. */ }
let hostPiVersion = 'unavailable'; let hostSdkVersion = 'unavailable';
try {
  hostPiVersion = execFileSync(process.env.PI_BIN ?? 'pi', ['--version'], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 }).trim();
  let directory = dirname(await realpath(process.env.PI_BIN));
  for (let i = 0; i < 6; i++, directory = dirname(directory)) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent') { hostSdkVersion = pkg.version; break; }
    } catch { /* Only inspect selected binary ancestors. */ }
  }
} catch { /* No private paths or diagnostics in public artifacts. */ }
const localSdkVersion = JSON.parse(await readFile('node_modules/@earendil-works/pi-coding-agent/package.json', 'utf8')).version;
const sourceStable = JSON.stringify(initial) === JSON.stringify(final);
const allSelectedScenariosPassed = sourceStable && testRunner.exitCode === 0 && !testRunner.signal && !testRunner.spawnError
  && data.results.every(row => row.result === 'passed')
  && JSON.stringify(data.results.map(row => row.scenario).sort()) === JSON.stringify([...expected].sort());
const loopback = ['NO_PROXY', 'no_proxy'].every(key => ['127.0.0.1', 'localhost'].every(host => (process.env[key] ?? '').split(',').includes(host)));
const ghHttp1 = (process.env.GODEBUG ?? '').split(',').includes('http2client=0');
const gitHttp1 = process.env.GIT_CONFIG_COUNT === '1' && process.env.GIT_CONFIG_KEY_0 === 'http.version' && process.env.GIT_CONFIG_VALUE_0 === 'HTTP/1.1';
const commandEnvironment = (loopback ? 'NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost ' : '')
  + (ghHttp1 ? 'GODEBUG=http2client=0 ' : '')
  + (gitHttp1 ? 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1 ' : '');
const report = { schema: 1, startedAt, completedAt: new Date().toISOString(), sha: initial.sha, dirty: initial.dirty,
  finalSha: final.sha, finalDirty: final.dirty, initialSourceDigest: initial.digest, finalSourceDigest: final.digest, sourceStable,
  command: commandEnvironment + `PI_BIN="$HOME/.npm-global/bin/pi" PI_PROVIDER=openai PI_MODEL=gpt-6-astra RUN_GITHUB_E2E=1 FLOW_ACCEPTANCE_REPOSITORY=nanzhi84/pi-implement-flow-reconciliation-acceptance${selected ? ` FLOW_RECONCILIATION_SCENARIO=${selected}` : ''} npm run test:reconciliation`,
  environment: { node: process.version, hostPiVersion, hostSdkVersion, localSdkVersion,
    provider: process.env.PI_PROVIDER, model: process.env.PI_MODEL, repository: process.env.FLOW_ACCEPTANCE_REPOSITORY,
    loopbackProxyBypass: loopback,
    ghHttp1,
    gitHttp1 },
  prerequisites: 'Authenticated gh and explicit OpenAI-capable pi; isolated synthetic reconciliation repository with approved content-addressed locator, no concurrent owner. Bypass loopback for fixed SDK HTTP scenarios. No production data.',
  boundary: 'Real pi/SDK/GitHub/commands/assets. Applied-responses-lost uses real OpenAI implementation and independent reviewers. Named CLI wrappers lose actual successful results or create explicit partial/corrupt synthetic assets; other model responses are fixed. Derived-operation cases call the production remote adapter through an explicit pi fixture command, not the later automatic repair/sync workflow.',
  expectedScenarios: expected, skippedScenarios: names.filter(name => !expected.includes(name)),
  testRunner, allSelectedScenariosPassed, assertionResults: data.results, createdRemoteFixtures: data.created,
  publicationEligible: allSelectedScenariosPassed && expected.length > 0 && !initial.dirty && !final.dirty,
  preservation: 'Failed and deliberate-fault workspaces retained; private locators excluded from public artifacts.' };
const bytes = JSON.stringify(report, null, 2) + '\n';
await writeFile('artifacts/reconciliation.json', bytes);
await writeFile(`artifacts/reconciliation-runs/${startedAt.replaceAll(':', '-')}.json`, bytes, { flag: 'wx' });
console.log(JSON.stringify({ allSelectedScenariosPassed, testRunner, sha: initial.sha }));
process.exitCode = allSelectedScenariosPassed ? 0 : 1;
