import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

// Only this outer process can know the test runner's final result, including hooks.
await mkdir('artifacts', { recursive: true });
await rm('artifacts/scenarios.json', { force: true });
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
const remote = process.env.RUN_GITHUB_E2E === '1';
const child = spawn(process.execPath, ['--test', 'tests/preflight.test.mjs'], { stdio: 'inherit' });
const result = await new Promise(resolve => {
  child.once('error', () => resolve({ exitCode: 1, signal: null }));
  child.once('exit', (code, signal) => resolve({ exitCode: code ?? 1, signal }));
});
let scenarios = [];
try { scenarios = JSON.parse(await readFile('artifacts/scenarios.json', 'utf8')); } catch { /* Failure artifact still emitted. */ }
let piVersion = 'unavailable';
try {
  piVersion = execFileSync(process.env.PI_BIN ?? 'pi', ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { /* Missing pi is reported without embedding its configured path. */ }
const expectedScenarios = remote ? 11 : 2;
const passed = result.exitCode === 0 && scenarios.length === expectedScenarios;
await writeFile('artifacts/preflight.json', JSON.stringify({
  schema: 1, sha, dirty,
  command: remote ? 'RUN_GITHUB_E2E=1 npm test' : 'npm test',
  environment: { node: process.version, pi: piVersion },
  faultInjection: { missingPi: piVersion === 'unavailable', cleanup: process.env.FLOW_ACCEPTANCE_FAIL_CLEANUP === '1' },
  boundary: 'Real pi RPC, temporary Git repositories, no model invocation; enabled remote case reads real GitHub',
  prerequisites: remote ? 'Read access to public acceptance repository; planning fixtures Spec #1/#3/#4/#7/#9/#12/#15/#18/#20; readable branch rules' : 'Node 24+, Git, pi 0.87.1',
  expectedScenarios, allSelectedScenariosPassed: passed, testRunner: result,
  skippedScenarios: remote ? [] : ['readable-rules-still-fail-closed', 'missing-acceptance-agreement', 'cyclic-dependencies', 'dependency-outside-spec', 'native-dependency-plan', 'qualified-reference-refused', 'invalid-zero-reference-refused', 'ambiguous-none-refused', 'fenced-planning-refused'],
  // These are assertion results, NOT whole-test success; testRunner includes cleanup.
  assertionResults: scenarios,
}, null, 2) + '\n');
process.exitCode = passed ? 0 : 1;
