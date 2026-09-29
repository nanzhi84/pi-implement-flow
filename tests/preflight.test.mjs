import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openPi } from './pi-client.mjs';

const evidence = [];
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

test('real pi refuses an unprepared project without dispatching or changing Git', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flow-preflight-'));
  const cwd = join(root, 'project');
  const agent = join(root, 'agent');
  await mkdir(cwd); await mkdir(agent);
  execFileSync('git', ['init', '-b', 'main', cwd], { stdio: 'ignore' });
  t.after(() => rm(root, { recursive: true, force: true }));
  const pi = await openPi(cwd, agent);
  t.after(() => pi.close());
  assert.match(await pi.flow('start 1'), /CONTRACT_MISSING/);
  assert.match(await pi.flow('status'), /idle/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }), '');
  evidence.push({ scenario: 'missing-contract', result: 'passed', entry: '/flow start 1', assertions: ['CONTRACT_MISSING', 'idle', 'Git unchanged'] });
});

test('real pi rejects malformed execution contracts before any confirmation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flow-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.pi'));
  await mkdir(join(root, 'agent'));
  await writeFile(join(root, '.pi/flow.json'), '{"version":1}');
  const pi = await openPi(root, join(root, 'agent'));
  t.after(() => pi.close());
  assert.match(await pi.flow('start 1'), /CONTRACT_INVALID/);
  assert.match(await pi.flow('status'), /idle/);
  evidence.push({ scenario: 'invalid-contract', result: 'passed', assertions: ['CONTRACT_INVALID', 'idle'] });
});

test('real GitHub unreadable protection refuses a well-formed direct-child plan', { skip: process.env.RUN_GITHUB_E2E !== '1' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'flow-github-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.pi'));
  await mkdir(join(root, 'agent'));
  await writeFile(join(root, '.pi/flow.json'), await readFile('tests/fixtures/flow.json'));
  await writeFile(join(root, 'AGENTS.md'), 'Isolated preflight fixture; no production data.');
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/nanzhi84/pi-implement-flow-acceptance.git'], { cwd: root });
  const pi = await openPi(root, join(root, 'agent'));
  t.after(() => pi.close());
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const output = await pi.flow('start 1');
  assert.match(output, /PLAN_READ: Spec #1; Tickets #2; concurrency 2/);
  assert.match(output, /PROTECTION_UNVERIFIABLE/);
  assert.match(await pi.flow('status'), /idle/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), before);
  evidence.push({ scenario: 'private-repository-protection-unreadable', result: 'passed',
    repository: 'nanzhi84/pi-implement-flow-acceptance', spec: 1, tickets: [2],
    assertions: ['native child plan read', 'PROTECTION_UNVERIFIABLE', 'idle', 'Git unchanged'] });
});

test.after(async () => {
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/preflight.json', JSON.stringify({
    schema: 1, sha, dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
    command: process.env.RUN_GITHUB_E2E === '1' ? 'RUN_GITHUB_E2E=1 npm test' : 'npm test',
    environment: { node: process.version, pi: execFileSync(process.env.PI_BIN ?? 'pi', ['--version'], { encoding: 'utf8' }).trim() },
    boundary: 'Real pi RPC, temporary Git repositories, no model invocation; remote case reads real GitHub when enabled',
    expectedScenarios: process.env.RUN_GITHUB_E2E === '1' ? 3 : 2,
    allSelectedScenariosPassed: evidence.length === (process.env.RUN_GITHUB_E2E === '1' ? 3 : 2),
    skippedScenarios: process.env.RUN_GITHUB_E2E === '1' ? [] : ['private-repository-protection-unreadable'],
    scenarios: evidence,
  }, null, 2) + '\n');
});
