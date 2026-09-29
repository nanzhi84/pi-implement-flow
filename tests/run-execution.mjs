import { spawn, execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const names = ['success', 'ambiguity', 'no-diff', 'cancellation'];
const selected = process.env.FLOW_EXECUTION_SCENARIO;
if (selected && !names.includes(selected)) throw new Error('Unsupported FLOW_EXECUTION_SCENARIO');
const remote = process.env.RUN_GITHUB_E2E === '1';
const expectedScenarios = remote ? (selected ? [selected] : names) : [];
await mkdir('artifacts', { recursive: true });
await mkdir('artifacts/execution-runs', { recursive: true });
try {
  const previous = await readFile('artifacts/execution.json', 'utf8');
  const stamp = JSON.parse(previous).startedAt.replaceAll(':', '-');
  await writeFile(`artifacts/execution-runs/${stamp}.json`, previous);
} catch { /* First run has no preceding report to retain. */ }
await rm('artifacts/execution-scenarios.json', { force: true });
async function sourceState() {
  const runGit = args => execFileSync('git', args, { encoding: 'utf8' });
  const hash = createHash('sha256');
  const paths = [...new Set(runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  for (const path of paths) {
    hash.update(path + '\0');
    try {
      const info = await lstat(path);
      hash.update(String(info.mode) + '\0');
      hash.update(info.isSymbolicLink() ? await readlink(path) : await readFile(path));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('missing');
    }
    hash.update('\0');
  }
  return { sha: runGit(['rev-parse', 'HEAD']).trim(), dirty: runGit(['status', '--porcelain']).trim() !== '', sourceDigest: hash.digest('hex') };
}
const initialSource = await sourceState();
const { sha, dirty } = initialSource;
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/execution.test.mjs'], { stdio: 'inherit' });
const testRunner = await new Promise(resolve => {
  child.once('error', () => resolve({ exitCode: 1, signal: null }));
  child.once('exit', (code, signal) => resolve({ exitCode: code ?? 1, signal }));
});
let data = { results: [], created: [] };
try { data = JSON.parse(await readFile('artifacts/execution-scenarios.json', 'utf8')); } catch { /* Final count and test runner fail closed. */ }
let pi = 'unavailable';
try { pi = execFileSync(process.env.PI_BIN ?? 'pi', ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Sanitized diagnostic only. */ }
const finalSource = await sourceState();
const sourceStable = initialSource.sha === finalSource.sha && initialSource.sourceDigest === finalSource.sourceDigest;
const passed = sourceStable && testRunner.exitCode === 0 && data.results.every(result => result.result === 'passed') && JSON.stringify(data.results.map(result => result.scenario).sort()) === JSON.stringify([...expectedScenarios].sort());
const cliHttp1 = process.env.GODEBUG?.split(',').includes('http2client=0')
  && process.env.GIT_CONFIG_COUNT === '1' && process.env.GIT_CONFIG_KEY_0 === 'http.version' && process.env.GIT_CONFIG_VALUE_0 === 'HTTP/1.1';
const command = (cliHttp1 ? 'GODEBUG=http2client=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1 ' : '')
  + (selected ? `FLOW_EXECUTION_SCENARIO=${selected} ` : '') + (remote ? 'RUN_GITHUB_E2E=1 ' : '')
  + (process.env.npm_lifecycle_event === 'test:execution' ? 'npm run test:execution' : 'node tests/run-execution.mjs');
const report = JSON.stringify({
  schema: 1, startedAt, completedAt: new Date().toISOString(), sha, dirty, command,
  finalSha: finalSource.sha, finalDirty: finalSource.dirty, sourceStable, initialSourceDigest: initialSource.sourceDigest, finalSourceDigest: finalSource.sourceDigest,
  publicationEligible: passed && remote && !dirty && !finalSource.dirty,
  environment: { node: process.version, pi, cliTransport: cliHttp1 ? 'HTTP/1.1 (TLS verification unchanged)' : 'environment default' },
  model: { provider: process.env.PI_PROVIDER ?? 'openai-codex', id: process.env.PI_MODEL ?? 'gpt-6-astra' },
  prerequisites: 'Authenticated gh with writes to acceptance repository; prepared synthetic greeting main; selected pi model credentials. Each selected scenario creates fresh Spec/native Ticket and retains remote synthetic evidence.',
  boundary: 'T2 only: one Ticket PR; no gates, Ticket merge/closure or final Spec delivery. Real model for success/ambiguity; fixed loopback HTTP transport only for deterministic no-diff/cancellation boundaries.',
  expectedScenarios, skippedScenarios: names.filter(name => !expectedScenarios.includes(name)),
  allSelectedScenariosPassed: passed, testRunner, assertionResults: data.results, createdRemoteFixtures: data.created,
  failurePreservation: 'Unverified temporary clones retained; private local locator is execution-preserved.local.json and must not be published.',
}, null, 2) + '\n';
await writeFile('artifacts/execution.json', report);
await writeFile(`artifacts/execution-runs/${startedAt.replaceAll(':', '-')}.json`, report);
process.exitCode = passed ? 0 : 1;
