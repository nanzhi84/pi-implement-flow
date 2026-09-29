import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openPi } from './pi-client.mjs';

const evidence = [];
async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
  if (process.env.FLOW_ACCEPTANCE_FAIL_CLEANUP === '1') throw new Error('Injected cleanup failure');
}

test('real pi refuses an unprepared project without dispatching or changing Git', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flow-preflight-'));
  const cwd = join(root, 'project');
  const agent = join(root, 'agent');
  await mkdir(cwd); await mkdir(agent);
  execFileSync('git', ['init', '-b', 'main', cwd], { stdio: 'ignore' });
  let pi;
  t.after(async () => { try { await pi?.close(); } finally { await cleanup(root); } });
  pi = await openPi(cwd, agent);
  assert.match(await pi.flow('start 1'), /CONTRACT_MISSING/);
  assert.match(await pi.flow('status'), /idle/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }), '');
  evidence.push({ scenario: 'missing-contract', result: 'passed', entry: '/flow start 1', assertions: ['CONTRACT_MISSING', 'idle', 'Git unchanged'] });
});

test('real pi rejects malformed execution contracts before any confirmation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flow-invalid-'));
  let pi;
  t.after(async () => { try { await pi?.close(); } finally { await cleanup(root); } });
  await mkdir(join(root, '.pi'));
  await mkdir(join(root, 'agent'));
  await writeFile(join(root, '.pi/flow.json'), '{"version":1}');
  pi = await openPi(root, join(root, 'agent'));
  assert.match(await pi.flow('start 1'), /CONTRACT_INVALID/);
  assert.match(await pi.flow('status'), /idle/);
  evidence.push({ scenario: 'invalid-contract', result: 'passed', assertions: ['CONTRACT_INVALID', 'idle'] });
});

test('real GitHub unreadable protection refuses a well-formed direct-child plan', { skip: process.env.RUN_GITHUB_E2E !== '1' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'flow-github-'));
  let pi;
  t.after(async () => { try { await pi?.close(); } finally { await cleanup(root); } });
  await mkdir(join(root, '.pi'));
  await mkdir(join(root, 'agent'));
  await writeFile(join(root, '.pi/flow.json'), await readFile('tests/fixtures/flow.json'));
  await writeFile(join(root, 'AGENTS.md'), 'Isolated preflight fixture; no production data.');
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/nanzhi84/pi-implement-flow-acceptance.git'], { cwd: root });
  pi = await openPi(root, join(root, 'agent'));
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
  await writeFile('artifacts/scenarios.json', JSON.stringify(evidence, null, 2) + '\n');
});
