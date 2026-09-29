import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const names = ['real-repair', 'progressive-five', 'no-progress-no-diff', 'no-progress-noise', 'conflict-repair', 'repair-needs-decision', 'review-progress'];
const selected = process.env.FLOW_REPAIR_SCENARIO;
if (selected && !names.includes(selected)) throw new Error('Unsupported FLOW_REPAIR_SCENARIO');
const remote = process.env.RUN_GITHUB_E2E === '1';
const expected = remote ? (selected ? [selected] : names) : [];
const startedAt = new Date().toISOString();
await mkdir('artifacts/repair-runs', { recursive: true });
try {
  const previous = await readFile('artifacts/repair.json', 'utf8');
  await writeFile(`artifacts/repair-runs/${JSON.parse(previous).startedAt.replaceAll(':', '-')}.json`, previous);
} catch { /* First execution has no previous report. */ }
await rm('artifacts/repair-scenarios.json', { force: true });
async function sourceState() {
  const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const hash = createHash('sha256');
  const paths = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  for (const path of paths) {
    hash.update(path + '\0');
    try {
      const info = await lstat(path); hash.update(String(info.mode) + '\0');
      hash.update(info.isSymbolicLink() ? await readlink(path) : await readFile(path));
    } catch (error) { if (error.code !== 'ENOENT') throw error; hash.update('missing'); }
    hash.update('\0');
  }
  return { sha: git(['rev-parse', 'HEAD']).trim(), dirty: git(['status', '--porcelain']).trim() !== '', sourceDigest: hash.digest('hex') };
}
const initial = await sourceState();
let hostPiVersion = 'unavailable';
try { hostPiVersion = execFileSync(process.env.PI_BIN ?? 'pi', ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
catch { /* No private executable path or stderr in evidence. */ }
let hostSdkVersion = 'unavailable';
if (process.env.PI_BIN) {
  try {
    let directory = dirname(await realpath(process.env.PI_BIN));
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (pkg.name === '@earendil-works/pi-coding-agent') { hostSdkVersion = pkg.version; break; }
      } catch { /* Search only ancestors of the explicitly selected host binary. */ }
      directory = dirname(directory);
    }
  } catch { /* An unavailable selected host is reported separately. */ }
}
let localSdkVersion = 'unavailable';
try { localSdkVersion = JSON.parse(await readFile('node_modules/@earendil-works/pi-coding-agent/package.json', 'utf8')).version; }
catch { /* Preserve missing dependency evidence. */ }
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/repair.test.mjs'], {
  stdio: 'inherit', env: { ...process.env, FLOW_EXECUTION_ARTIFACT_PREFIX: 'repair' },
});
const testRunner = await new Promise(resolve => {
  child.once('error', () => resolve({ exitCode: null, signal: null, spawnError: true }));
  child.once('exit', (exitCode, signal) => resolve({ exitCode, signal, spawnError: false }));
});
let data = { results: [], created: [] };
try { data = JSON.parse(await readFile('artifacts/repair-scenarios.json', 'utf8')); } catch { /* Exact result count fails closed. */ }
const final = await sourceState();
const sourceStable = initial.sha === final.sha && initial.dirty === final.dirty && initial.sourceDigest === final.sourceDigest;
const passed = sourceStable && testRunner.exitCode === 0 && !testRunner.signal && !testRunner.spawnError
  && data.results.every(result => result.result === 'passed')
  && JSON.stringify(data.results.map(result => result.scenario).sort()) === JSON.stringify([...expected].sort());
const noProxy = name => (process.env[name] ?? '').split(',').map(value => value.trim().toLowerCase());
const publicProxyHosts = ['127.0.0.1', 'localhost', 'api.github.com', 'github.com', '.githubusercontent.com'];
const publicBypass = name => publicProxyHosts.filter(host => noProxy(name).includes(host));
const proxyAssignment = name => noProxy(name).includes('*') ? `${name}="*" ` : publicBypass(name).length ? `${name}=${publicBypass(name).join(',')} ` : '';
const loopback = name => ['127.0.0.1', 'localhost'].every(host => noProxy(name).includes(host) || noProxy(name).includes('*'));
const cliHttp1 = process.env.GODEBUG?.split(',').includes('http2client=0') && process.env.GIT_CONFIG_COUNT === '1'
  && process.env.GIT_CONFIG_KEY_0 === 'http.version' && process.env.GIT_CONFIG_VALUE_0 === 'HTTP/1.1';
const piChoice = process.env.PI_BIN === join(homedir(), '.npm-global/bin/pi') ? '$HOME/.npm-global/bin/pi' : '$PI_BIN';
const command = 'FLOW_ACCEPTANCE_REPOSITORY=nanzhi84/pi-implement-flow-repair-acceptance ' + (cliHttp1 ? 'GODEBUG=http2client=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1 ' : '')
  + proxyAssignment('NO_PROXY') + proxyAssignment('no_proxy')
  + (process.env.PI_BIN ? `PI_BIN="${piChoice}" ` : '')
  + `PI_PROVIDER=${process.env.PI_PROVIDER ?? 'openai'} PI_MODEL=${process.env.PI_MODEL ?? 'gpt-6-astra'} `
  + (selected ? `FLOW_REPAIR_SCENARIO=${selected} ` : '') + (remote ? 'RUN_GITHUB_E2E=1 ' : '')
  + (process.env.npm_lifecycle_event === 'test:repair' ? 'npm run test:repair' : 'node tests/run-repair.mjs');
const report = {
  schema: 1, startedAt, completedAt: new Date().toISOString(), command,
  sha: initial.sha, dirty: initial.dirty, finalSha: final.sha, finalDirty: final.dirty, sourceStable,
  initialSourceDigest: initial.sourceDigest, finalSourceDigest: final.sourceDigest,
  environment: { repository: process.env.FLOW_ACCEPTANCE_REPOSITORY === 'nanzhi84/pi-implement-flow-repair-acceptance' ? process.env.FLOW_ACCEPTANCE_REPOSITORY : 'required explicit repair repository was not selected', node: process.version, hostPiVersion, hostSdkVersion, localSdkVersion,
    piSelection: process.env.PI_BIN ? 'explicit PI_BIN; private path omitted' : 'PATH',
    provider: process.env.PI_PROVIDER ?? 'openai', model: process.env.PI_MODEL ?? 'gpt-6-astra',
    NO_PROXYIncludesLoopback: loopback('NO_PROXY'), no_proxyIncludesLoopback: loopback('no_proxy'),
    NO_PROXYPublicHosts: publicBypass('NO_PROXY'), no_proxyPublicHosts: publicBypass('no_proxy'),
    NO_PROXYWildcard: noProxy('NO_PROXY').includes('*'), no_proxyWildcard: noProxy('no_proxy').includes('*'),
    proxyEvidenceBoundary: 'Only loopback and public GitHub bypass hosts are recorded; arbitrary private host entries are not disclosed',
    cliTransport: cliHttp1 ? 'HTTP/1.1; TLS verification unchanged' : 'environment default' },
  prerequisites: 'Authenticated gh writes to synthetic acceptance repository; clean main greeting baseline; explicit OpenAI-capable host PI_BIN and existing credentials for openai/gpt-6-astra; development SDK remains pinned. Fixed HTTP scenarios require effective NO_PROXY/no_proxy bypass for 127.0.0.1 and localhost when the host uses a proxy. New Specs permit only additive acceptance assertions and Ticket repair; existing main/rules/fixtures are preserved.',
  boundary: 'Real pi RPC, role SDK tools, actual CLI assertions, same GitHub PR and downloaded artifacts. real-repair supplies only its initial defective model transport deterministically, then dispatches real openai/gpt-6-astra for every repair and independent review. Other model HTTP responses are explicitly fixed. progressive-five also exposes null plus the previous C for two successful actual GET responses after its first append; subsequent ready C and every remote write remain real. Independent raw Git object verification checks continuous edit/merge segments, modes, full changed-path coverage and canonical merge preparation. No unit tests or production stop flags. Prior SHA reports do not count as current coverage.',
  expectedScenarios: expected, skippedScenarios: names.filter(name => !expected.includes(name)),
  allSelectedScenariosPassed: passed, testRunner, assertionResults: data.results, createdRemoteFixtures: data.created,
  publicationEligible: passed && expected.length === names.length && !initial.dirty && !final.dirty,
  deferredScenarios: ['unknown remote write reconciliation belongs to #11', 'actual merged-M repair via new Ticket belongs to #15'],
  failurePreservation: 'Unverified and intentional-failure workspaces retained; repair-preserved.local.json is private and must not be published.',
};
const content = JSON.stringify(report, null, 2) + '\n';
await writeFile('artifacts/repair.json', content);
await writeFile(`artifacts/repair-runs/${startedAt.replaceAll(':', '-')}.json`, content);
process.exitCode = passed ? 0 : 1;
