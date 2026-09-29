import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, access, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openPi } from './pi-client.mjs';
import { fileURLToPath } from 'node:url';

const results = [];
const model = { provider: process.env.PI_PROVIDER ?? 'openai-codex', id: process.env.PI_MODEL ?? 'gpt-6-astra' };
const skip = process.env.RUN_GITHUB_E2E !== '1';
async function fixture(t, credentials = true, env = {}) {
  const root = await mkdtemp(join(tmpdir(), 'flow-startup-'));
  const clients = [];
  t.after(async () => {
    try { for (const pi of clients) await pi.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const project = join(root, 'project');
  execFileSync('git', ['clone', '--quiet', 'https://github.com/nanzhi84/pi-implement-flow-acceptance.git', project], { stdio: 'pipe' });
  const agent = join(root, 'agent');
  await mkdir(agent);
  if (credentials) {
    // Only explicit auth/model files, never extensions, settings, skills or instructions.
    const source = process.env.FLOW_TEST_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent');
    for (const file of ['auth.json', 'models.json']) {
      const path = join(source, file);
      try { await access(path); } catch { continue; }
      await symlink(path, join(agent, file));
    }
  }
  return { project, async open(options = {}) { const pi = await openPi(project, agent, { model, env, ...options }); clients.push(pi); return pi; } };
}

test('real pi confirms, probes, publishes, excludes another controller and pauses on session change', { skip }, async t => {
  const f = await fixture(t);
  const first = await f.open();
  const output = await first.flow('start 1 --concurrency 2', true);
  assert.match(output, /FLOW_STARTED/);
  assert.match(output, /paused.*executor-not-installed/);
  const link = /EVIDENCE_URL: (https:\/\/github\.com\/[^\s]+)/.exec(output)?.[1];
  assert.ok(link, 'published evidence URL must be visible');
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(link);
  assert.ok(match);
  const downloaded = execFileSync('gh', ['release', 'download', match[2], '--repo', match[1], '--pattern', match[3], '--output', '-'], { encoding: 'utf8' });
  const report = JSON.parse(downloaded);
  assert.equal(report.codeSha, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.project, encoding: 'utf8' }).trim());
  assert.deepEqual(report.acceptance.assertions.map(a => a.name), ['greeting-for-name', 'missing-name-rejected']);
  assert.equal(report.cleanup, 'passed');
  const otherClone = await fixture(t);
  const second = await otherClone.open();
  assert.match(await second.flow('start 1', true), /FLOW_OWNED/);
  const boundary = first.notices.length;
  await first.request('new_session');
  assert.match(first.notices.slice(boundary).join('\n'), /FLOW_PAUSED.*session/);
  assert.match(await second.flow('start 1', false), /CANCELLED/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: f.project, encoding: 'utf8' }), '');
  results.push({ scenario: 'confirmed-startup', result: 'passed', evidenceUrl: link, assertions: ['real commands', 'remote bytes verified', 'exclusive controller', 'session pause', 'cancel before probes', 'Git unchanged'] });
});

test('real pi rejects unavailable independent-agent authentication', { skip }, async t => {
  const f = await fixture(t, false);
  const pi = await f.open();
  assert.match(await pi.flow('start 1', true), /AGENT_UNAVAILABLE/);
  assert.doesNotMatch(await pi.flow('status'), /started/);
  results.push({ scenario: 'agent-readiness-refused', result: 'passed', assertions: ['AGENT_UNAVAILABLE', 'not started'] });
});

test('real preparation failure cleans up and never claims startup', { skip }, async t => {
  const f = await fixture(t, true, { FLOW_FIXTURE_FAIL_PREPARE: '1' });
  const pi = await f.open();
  const output = await pi.flow('start 1', true);
  assert.match(output, /COMMAND_FAILED.*prepare/);
  assert.doesNotMatch(output, /FLOW_STARTED/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: f.project, encoding: 'utf8' }), '');
  results.push({ scenario: 'preparation-failure', result: 'passed', assertions: ['command failure classified', 'no startup', 'Git unchanged'] });
});

test('approval cannot authorize a contract edited while confirmation is open', { skip }, async t => {
  const f = await fixture(t);
  const path = join(f.project, '.pi/flow.json');
  const pi = await f.open({ onConfirm: async dialog => {
    assert.match(dialog.message, /Acceptance criteria/);
    const contract = JSON.parse(await readFile(path, 'utf8'));
    contract.commandTimeoutMs += 1;
    await writeFile(path, JSON.stringify(contract, null, 2) + '\n');
    return true;
  } });
  const output = await pi.flow('start 1', true);
  assert.match(output, /PROJECT_UNPREPARED|SCOPE_CHANGED/);
  assert.doesNotMatch(output, /FLOW_STARTED|REVIEW_READY/);
  assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: f.project, encoding: 'utf8' }), /flow.json/);
  results.push({ scenario: 'confirmation-race', result: 'passed', assertions: ['old approval rejected', 'changed local work preserved', 'no probe started'] });
});

for (const action of ['fork', 'tree', 'reload']) {
  test(`real pi ${action} cancels an in-flight confirmation without dispatch`, { skip }, async t => {
    const f = await fixture(t);
    let pi;
    let transition;
    pi = await f.open({
      extensions: [fileURLToPath(new URL('./fixtures/lifecycle-bridge.ts', import.meta.url))],
      onConfirm: () => {
        transition = pi.request('prompt', { message: `/fixture-${action}` });
        return transition.then(() => true); // A late approval must have no authority.
      },
    });
    assert.equal((await pi.request('prompt', { message: '/fixture-seed' })).success, true);
    await pi.flow('start 1', true);
    assert.ok(transition, 'confirmation was reached');
    assert.equal((await transition).success, true);
    assert.match(pi.notices.join('\n'), /FLOW_PAUSED/);
    assert.doesNotMatch(pi.notices.join('\n'), /FLOW_STARTED|REVIEW_READY/);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: f.project, encoding: 'utf8' }), '');
    results.push({ scenario: `session-${action}`, result: 'passed', assertions: ['real pi lifecycle operation', 'late approval rejected', 'no dispatch', 'Git unchanged'] });
  });
}

test.after(async () => {
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/startup-scenarios.json', JSON.stringify(results, null, 2) + '\n');
});
