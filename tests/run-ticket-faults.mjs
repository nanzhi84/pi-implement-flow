import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const names = ['prepare-drift', 'cleanup-drift', 'push-unknown'];
const selected = process.env.FLOW_TICKET_FAULT_SCENARIO;
if (selected && !names.includes(selected)) throw new Error('Unsupported FLOW_TICKET_FAULT_SCENARIO');
const remote = process.env.RUN_GITHUB_E2E === '1';
const expected = remote ? (selected ? [selected] : names) : [];
await mkdir('artifacts/ticket-fault-runs', { recursive: true });
await rm('artifacts/ticket-faults-scenarios.json', { force: true });
const startedAt = new Date().toISOString();
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/ticket-faults.test.mjs'], {
  stdio: 'inherit', env: { ...process.env, FLOW_EXECUTION_ARTIFACT_PREFIX: 'ticket-faults' },
});
const testRunner = await new Promise(resolve => {
  child.once('error', () => resolve({ exitCode: 1, signal: null }));
  child.once('exit', (code, signal) => resolve({ exitCode: code ?? 1, signal }));
});
let data = { results: [], created: [] };
try { data = JSON.parse(await readFile('artifacts/ticket-faults-scenarios.json', 'utf8')); } catch { /* The exact scenario count fails closed. */ }
let cli = 'unavailable';
try { cli = execFileSync(process.env.PI_BIN ?? 'pi', ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Do not include configured paths. */ }
const sdk = JSON.parse(await readFile('node_modules/@earendil-works/pi-coding-agent/package.json', 'utf8')).version;
const finalSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const finalDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
const sourceStable = sha === finalSha && !dirty && !finalDirty;
const passed = sourceStable && testRunner.exitCode === 0 && data.results.every(result => result.result === 'passed')
  && JSON.stringify(data.results.map(result => result.scenario).sort()) === JSON.stringify([...expected].sort());
const http1 = process.env.GODEBUG?.split(',').includes('http2client=0')
  && process.env.GIT_CONFIG_COUNT === '1' && process.env.GIT_CONFIG_KEY_0 === 'http.version' && process.env.GIT_CONFIG_VALUE_0 === 'HTTP/1.1';
const report = JSON.stringify({
  schema: 1, startedAt, completedAt: new Date().toISOString(), sha, dirty, finalSha, finalDirty, sourceStable,
  command: (http1 ? 'GODEBUG=http2client=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1 ' : '')
    + (selected ? `FLOW_TICKET_FAULT_SCENARIO=${selected} ` : '') + (remote ? 'RUN_GITHUB_E2E=1 ' : '') + 'npm run test:ticket-faults',
  environment: { node: process.version, piCli: cli, localDevelopmentSdk: sdk, cliTransport: http1 ? 'HTTP/1.1 (TLS unchanged)' : 'environment default',
    runtimeBinding: 'pi extension imports use the running CLI SDK, which may differ from the locally typechecked development SDK; npm scripts prefer project-local pi' },
  prerequisites: 'Authenticated gh with synthetic acceptance-repository writes; prepared greeting main; no concurrent owner. No external model credentials. Fresh Spec/native Ticket per scenario.',
  boundary: 'Real pi RPC/SDK/GitHub and project/Git commands. Only CLI post-success outcome is injected; deterministic loopback model is control evidence, not model quality.',
  expectedScenarios: expected, skippedScenarios: names.filter(name => !expected.includes(name)),
  allSelectedScenariosPassed: passed, testRunner, assertionResults: data.results, createdRemoteFixtures: data.created,
  preservation: 'Fault workspaces preserved even on success. Local private locator ticket-faults-preserved.local.json must not be published. Remote synthetic Issues/branches/assets remain unchanged after assertions.',
}, null, 2) + '\n';
await writeFile('artifacts/ticket-faults.json', report);
await writeFile(`artifacts/ticket-fault-runs/${startedAt.replaceAll(':', '-')}.json`, report);
process.exitCode = passed ? 0 : 1;
