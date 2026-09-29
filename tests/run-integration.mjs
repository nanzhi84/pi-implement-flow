import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const names = ['real-integration', 'accept-failure', 'review-rejects-self-approval', 'evidence-unavailable',
  'stale-head', 'stale-base', 'actual-merge-recheck-fails', 'actual-review-blockers-recorded', 'base-race-after-final-read', 'review-response-too-large'];
const selected = process.env.FLOW_INTEGRATION_SCENARIO;
if (selected && !names.includes(selected)) throw new Error('Unsupported FLOW_INTEGRATION_SCENARIO');
const remote = process.env.RUN_GITHUB_E2E === '1';
const expected = remote ? (selected ? [selected] : names) : [];
const startedAt = new Date().toISOString();
await mkdir('artifacts/integration-runs', { recursive: true });
try {
  const previous = await readFile('artifacts/integration.json', 'utf8');
  await writeFile(`artifacts/integration-runs/${JSON.parse(previous).startedAt.replaceAll(':', '-')}.json`, previous);
} catch { /* First execution has no previous report. */ }
await rm('artifacts/integration-scenarios.json', { force: true });
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
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/integration.test.mjs'], {
  stdio: 'inherit', env: { ...process.env, FLOW_EXECUTION_ARTIFACT_PREFIX: 'integration' },
});
const testRunner = await new Promise(resolve => {
  child.once('error', () => resolve({ exitCode: null, signal: null, spawnError: true }));
  child.once('exit', (exitCode, signal) => resolve({ exitCode, signal, spawnError: false }));
});
let data = { results: [], created: [] };
try { data = JSON.parse(await readFile('artifacts/integration-scenarios.json', 'utf8')); } catch { /* Exact result count fails closed. */ }
const final = await sourceState();
const sourceStable = initial.sha === final.sha && initial.dirty === final.dirty && initial.sourceDigest === final.sourceDigest;
const passed = sourceStable && testRunner.exitCode === 0 && !testRunner.signal && !testRunner.spawnError
  && data.results.every(result => result.result === 'passed')
  && JSON.stringify(data.results.map(result => result.scenario).sort()) === JSON.stringify([...expected].sort());
let nativeReviewVerified = false;
const nativePath = process.env.FLOW_NATIVE_REVIEW_REPORT ?? 'artifacts/preflight.json';
try {
  const native = JSON.parse(await readFile(nativePath, 'utf8'));
  nativeReviewVerified = native.sha === initial.sha && native.finalSha === initial.sha && native.sourceStable
    && native.testRunner?.exitCode === 0 && !native.testRunner?.signal && native.allSelectedScenariosPassed
    && native.assertionResults?.some(result => result.scenario === 'native-review-required' && result.result === 'passed');
} catch { /* Reuse requires a real same-SHA successful T1 report, never an assumption. */ }
const noProxy = name => (process.env[name] ?? '').split(',').map(value => value.trim().toLowerCase());
const publicProxyHosts = ['127.0.0.1', 'localhost', 'api.github.com', 'github.com', '.githubusercontent.com'];
const publicBypass = name => publicProxyHosts.filter(host => noProxy(name).includes(host));
const proxyAssignment = name => noProxy(name).includes('*') ? `${name}="*" ` : publicBypass(name).length ? `${name}=${publicBypass(name).join(',')} ` : '';
const loopback = name => ['127.0.0.1', 'localhost'].every(host => noProxy(name).includes(host) || noProxy(name).includes('*'));
const cliHttp1 = process.env.GODEBUG?.split(',').includes('http2client=0') && process.env.GIT_CONFIG_COUNT === '1'
  && process.env.GIT_CONFIG_KEY_0 === 'http.version' && process.env.GIT_CONFIG_VALUE_0 === 'HTTP/1.1';
const piChoice = process.env.PI_BIN === join(homedir(), '.npm-global/bin/pi') ? '$HOME/.npm-global/bin/pi' : '$PI_BIN';
const command = (cliHttp1 ? 'GODEBUG=http2client=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1 ' : '')
  + proxyAssignment('NO_PROXY') + proxyAssignment('no_proxy')
  + (process.env.PI_BIN ? `PI_BIN="${piChoice}" ` : '')
  + `PI_PROVIDER=${process.env.PI_PROVIDER ?? 'openai'} PI_MODEL=${process.env.PI_MODEL ?? 'gpt-6-astra'} `
  + (selected ? `FLOW_INTEGRATION_SCENARIO=${selected} ` : '') + (remote ? 'RUN_GITHUB_E2E=1 ' : '')
  + (process.env.npm_lifecycle_event === 'test:integration' ? 'npm run test:integration' : 'node tests/run-integration.mjs');
const report = {
  schema: 1, startedAt, completedAt: new Date().toISOString(), command,
  sha: initial.sha, dirty: initial.dirty, finalSha: final.sha, finalDirty: final.dirty, sourceStable,
  initialSourceDigest: initial.sourceDigest, finalSourceDigest: final.sourceDigest,
  environment: { node: process.version, hostPiVersion, hostSdkVersion, localSdkVersion,
    piSelection: process.env.PI_BIN ? 'explicit PI_BIN; private path omitted' : 'PATH',
    provider: process.env.PI_PROVIDER ?? 'openai', model: process.env.PI_MODEL ?? 'gpt-6-astra',
    NO_PROXYIncludesLoopback: loopback('NO_PROXY'), no_proxyIncludesLoopback: loopback('no_proxy'),
    NO_PROXYPublicHosts: publicBypass('NO_PROXY'), no_proxyPublicHosts: publicBypass('no_proxy'),
    NO_PROXYWildcard: noProxy('NO_PROXY').includes('*'), no_proxyWildcard: noProxy('no_proxy').includes('*'),
    proxyEvidenceBoundary: 'Only loopback and public GitHub bypass hosts are recorded; arbitrary private host entries are not disclosed',
    cliTransport: cliHttp1 ? 'HTTP/1.1; TLS verification unchanged' : 'environment default' },
  prerequisites: 'Authenticated gh writes to synthetic acceptance repository; clean main greeting baseline; explicit OpenAI-capable host PI_BIN and existing credentials for openai/gpt-6-astra; development SDK remains pinned. Fixed HTTP scenarios require effective NO_PROXY/no_proxy bypass for 127.0.0.1 and localhost when the host uses a proxy. New Specs permit only additive acceptance assertions and Ticket integration; existing main/rules/fixtures are preserved.',
  boundary: 'Real pi RPC, SDK tools, GitHub PRs/merge/Issues and remote artifacts in every selected case. Normal path uses real OpenAI implementation and independent reviewer. Raw Git blob bytes independently verify controlled mutation chains, full changed-file coverage and the final acceptance file being written before implementation changes; this does not prove a failing test ran first or audit arbitrary OS writes. Other model HTTP responses are deterministic; named command/transport or external branch-write injections are explicitly recorded. Final Spec delivery and native required-review success are not implemented by this suite.',
  expectedScenarios: expected, skippedScenarios: names.filter(name => !expected.includes(name)),
  allSelectedScenariosPassed: passed, testRunner, assertionResults: data.results, createdRemoteFixtures: data.created,
  nativeReview: { sameShaRefusalEvidenceVerified: !!nativeReviewVerified, source: nativePath === 'artifacts/preflight.json' ? nativePath : 'FLOW_NATIVE_REVIEW_REPORT (path omitted)', successPathSupported: false },
  publicationEligible: passed && expected.length === names.length && nativeReviewVerified && !initial.dirty && !final.dirty,
  deferredScenarios: ['head changes after final read', 'merge response lost', 'closure response lost', 'cancellation at every merge phase', 'new scope change during actual-M gate'],
  failurePreservation: 'Unverified and intentional-failure workspaces retained; integration-preserved.local.json is private and must not be published.',
};
const content = JSON.stringify(report, null, 2) + '\n';
await writeFile('artifacts/integration.json', content);
await writeFile(`artifacts/integration-runs/${startedAt.replaceAll(':', '-')}.json`, content);
process.exitCode = passed ? 0 : 1;
