import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { repository } from './acceptance-repository.mjs';

const names = ['model-transient', 'model-exhausted', 'model-permanent', 'model-quota', 'model-invalid', 'model-cancel-retry',
  'github-eof', 'github-permanent', 'github-certificate-expired', 'github-certificate-untrusted', 'github-tls-unknown',
  'gate-behavior', 'gate-infrastructure', 'gate-configuration', 'gate-unclassified',
  'gate-invalid-report', 'gate-success-contradiction', 'gate-timeout-report'];
const selected = process.env.FLOW_INFRASTRUCTURE_SCENARIO;
if (selected && !names.includes(selected)) throw new Error('Unsupported FLOW_INFRASTRUCTURE_SCENARIO');
const remote = process.env.RUN_GITHUB_E2E === '1';
const expected = remote ? (selected ? [selected] : names) : [];
const startedAt = new Date().toISOString();
await mkdir('artifacts/infrastructure-runs', { recursive: true });
try {
  const previous = await readFile('artifacts/infrastructure.json', 'utf8');
  await writeFile(`artifacts/infrastructure-runs/${JSON.parse(previous).startedAt.replaceAll(':', '-')}.json`, previous);
} catch { /* First execution has no previous report. */ }
await rm('artifacts/infrastructure-scenarios.json', { force: true });
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
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/infrastructure.test.mjs'], {
  stdio: 'inherit', env: { ...process.env, FLOW_EXECUTION_ARTIFACT_PREFIX: 'infrastructure' },
});
const testRunner = await new Promise(resolve => {
  child.once('error', () => resolve({ exitCode: null, signal: null, spawnError: true }));
  child.once('exit', (exitCode, signal) => resolve({ exitCode, signal, spawnError: false }));
});
let data = { results: [], created: [] };
try { data = JSON.parse(await readFile('artifacts/infrastructure-scenarios.json', 'utf8')); } catch { /* Exact result count fails closed. */ }
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
const command = (cliHttp1 ? 'GODEBUG=http2client=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1 ' : '')
  + proxyAssignment('NO_PROXY') + proxyAssignment('no_proxy')
  + (process.env.PI_BIN ? `PI_BIN="${piChoice}" ` : '')
  + `FLOW_ACCEPTANCE_REPOSITORY=${repository} `
  + (selected ? `FLOW_INFRASTRUCTURE_SCENARIO=${selected} ` : '') + (remote ? 'RUN_GITHUB_E2E=1 ' : '')
  + (process.env.npm_lifecycle_event === 'test:infrastructure' ? 'npm run test:infrastructure' : 'node tests/run-infrastructure.mjs');
const report = {
  schema: 1, startedAt, completedAt: new Date().toISOString(), command,
  sha: initial.sha, dirty: initial.dirty, finalSha: final.sha, finalDirty: final.dirty, sourceStable,
  initialSourceDigest: initial.sourceDigest, finalSourceDigest: final.sourceDigest,
  environment: { node: process.version, hostPiVersion, hostSdkVersion, localSdkVersion,
    piSelection: process.env.PI_BIN ? 'explicit PI_BIN; private path omitted' : 'PATH',
    provider: 'fixed loopback HTTP providers', model: 'fixed', repository,
    NO_PROXYIncludesLoopback: loopback('NO_PROXY'), no_proxyIncludesLoopback: loopback('no_proxy'),
    NO_PROXYPublicHosts: publicBypass('NO_PROXY'), no_proxyPublicHosts: publicBypass('no_proxy'),
    NO_PROXYWildcard: noProxy('NO_PROXY').includes('*'), no_proxyWildcard: noProxy('no_proxy').includes('*'),
    proxyEvidenceBoundary: 'Only loopback and public GitHub bypass hosts are recorded; arbitrary private host entries are not disclosed',
    cliTransport: cliHttp1 ? 'HTTP/1.1; TLS verification unchanged' : 'environment default' },
  prerequisites: 'Authenticated gh writes to the explicitly allowlisted synthetic acceptance repository; clean greeting main with retry enabled/maxRetries=2/providerMaxRetries=0; no concurrent owner of that repository. Explicit PI_BIN selects the actual host SDK. No external model credentials are required by these fixed HTTP cases. Proxied environments need effective NO_PROXY/no_proxy loopback bypass.',
  boundary: 'Real pi RPC, installed SDK, controlled HTTP provider and GitHub/project commands. Fixed model responses verify transport/control behavior, not model quality. CLI injections run the actual read or acceptance successfully before replacing its result; pre-injection failures do not count as injected success. SDK owns all recovery; no test retries individual failed operations. Normal OpenAI integration and existing lifecycle/unknown-effect regressions are separate reports at the same frozen SHA.',
  expectedScenarios: expected, skippedScenarios: names.filter(name => !expected.includes(name)),
  allSelectedScenariosPassed: passed, testRunner, assertionResults: data.results, createdRemoteFixtures: data.created,
  publicationEligible: passed && expected.length === names.length && !initial.dirty && !final.dirty,
  unverifiedBoundaries: ['SDK retry disabled contract', 'all provider-specific retry classifications', 'all malformed report permutations', 'remote write reconciliation (separate Ticket)'],
  failurePreservation: 'Every fault workspace is retained, including observed successful refusals; infrastructure-preserved.local.json is private and must not be published.',
};
const content = JSON.stringify(report, null, 2) + '\n';
await writeFile('artifacts/infrastructure.json', content);
await writeFile(`artifacts/infrastructure-runs/${startedAt.replaceAll(':', '-')}.json`, content);
process.exitCode = passed ? 0 : 1;
