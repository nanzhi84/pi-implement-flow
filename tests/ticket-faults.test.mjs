import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, fixture, fixedProvider, git, persist, repository } from './execution-fixture.mjs';
import { openPi } from './pi-client.mjs';

const selected = process.env.FLOW_TICKET_FAULT_SCENARIO;
const skip = scenario => process.env.RUN_GITHUB_E2E !== '1' || (selected && selected !== scenario);
const bridge = fileURLToPath(new URL('./fixtures/ticket-fault-bridge.mjs', import.meta.url));
const options = scenario => ({ preserveOnPass: true,
  ticketRequest: `Synthetic ${scenario} control acceptance. The existing Ada greeting already satisfies this Ticket. Do not modify any source, command, instruction or acceptance file. Return implemented without edits if dispatched. The harness injects the named fault at a real project-command or Git CLI boundary. Stop delivery safely when the controller detects that fault.`,
});

async function arm(pi, phase) {
  const result = await pi.request('prompt', { message: `/fixture-ticket-fault ${phase}` });
  assert.equal(result.success, true);
  assert.ok(pi.notices.some(notice => notice.includes(`FAULT_ARMED: ${phase}`)));
}
async function counts(pi) {
  const result = await pi.request('prompt', { message: '/fixture-ticket-fault-status' });
  assert.equal(result.success, true);
  const notice = pi.notices.findLast(message => message.startsWith('FAULT_COUNTS: '));
  assert.ok(notice);
  return JSON.parse(notice.slice('FAULT_COUNTS: '.length));
}
function noTicketDelivery(f) {
  assert.equal(f.pulls().length, 0, 'no Ticket PR');
  assert.equal(git(f.project, 'ls-remote', '--heads', 'origin', `refs/heads/flow/ticket-${f.spec.number}-${f.ticket.number}`), '', 'no Ticket branch push');
  f.verifyInvariants();
}

for (const scenario of ['prepare-drift', 'cleanup-drift']) {
  test(`real Ticket ${scenario} preserves source and refuses delivery`, { skip: skip(scenario), timeout: 1_200_000 }, async t => {
    const fixed = await fixedProvider(t, { kind: 'implemented', summary: 'The greeting already meets the synthetic Ticket; no edits were made.' });
    const f = await fixture(t, scenario, { ...options(scenario), fixed });
    const pi = await f.open({ extensions: [bridge] });
    await arm(pi, scenario);
    const output = await pi.flow(`start ${f.spec.number}`, true);
    assert.match(output, /WORKSPACE_DRIFT/);
    assert.match(output, new RegExp(`FAULT_APPLIED: ${scenario}`));
    assert.doesNotMatch(output, /TICKET_PR:|FLOW_STARTED:/);
    assert.equal(fixed.requests.length, scenario === 'prepare-drift' ? 0 : 1,
      'prepare drift must stop before model dispatch; cleanup drift follows a real SDK result');
    const workspace = f.worktrees().find(path => path !== f.project);
    assert.ok(workspace, 'Ticket workspace is retained');
    assert.equal(git(workspace, 'rev-parse', 'HEAD'), f.baseline, 'no commit was created');
    assert.equal(git(workspace, 'symbolic-ref', '--short', 'HEAD'), `flow/ticket-${f.spec.number}-${f.ticket.number}`);
    assert.match(git(workspace, 'status', '--porcelain'), /app\.mjs/);
    assert.match(await readFile(join(workspace, 'app.mjs'), 'utf8'), new RegExp(`Synthetic Ticket ${scenario} fault`));
    await assert.rejects(access(join(workspace, '..', 'resources', 'data')), 'real fixture cleanup released its synthetic data');
    const observed = await counts(pi);
    assert.deepEqual(observed, { phase: scenario, attempts: 1, applied: 1 });
    noTicketDelivery(f);
    f.pass({ boundary: 'Real pi/SDK/GitHub; real Ticket project command followed by explicit CLI source-drift injection',
      modelRequests: fixed.requests.length, commandFault: observed,
      featureSha: git(f.project, 'ls-remote', '--heads', 'origin', `refs/heads/${f.feature}`).split(/\s+/)[0],
      assertions: ['preflight remained valid', 'source drift refused', 'dirty Ticket workspace retained', 'actual fixture resources cleaned', 'no implementation commit', 'no Ticket push or PR', 'Issues remain open', 'original checkout and remote main unchanged'] });
  });
}

test('accepted feature push with lost response and unavailable readback retains ownership without replay', { skip: skip('push-unknown'), timeout: 1_200_000 }, async t => {
  const identity = api(`repos/${repository}`).id;
  const key = createHash('sha256').update(`github.com:${identity}`).digest('hex').slice(0, 24);
  const socket = `/tmp/pi-flow-${process.getuid()}-${key}.sock`;
  await assert.rejects(access(socket), 'never take over an existing controller or stale socket');
  const fixed = await fixedProvider(t, { kind: 'implemented', summary: 'No model dispatch is expected.' });
  const f = await fixture(t, 'push-unknown', { ...options('push-unknown'), fixed });
  // Registered after fixture teardown: its actual pi process is closed first.
  t.after(async () => {
    try { await access(socket); } catch { return; }
    let noOwner = false;
    try { execFileSync('lsof', ['-t', socket], { stdio: 'pipe' }); }
    catch (error) { noOwner = error.status === 1; }
    assert.equal(noOwner, true, 'do not remove a socket with a live owner');
    await rm(socket); // Only the initially absent socket owned by this fixture.
  });
  const pi = await f.open({ extensions: [bridge] });
  await arm(pi, 'push-unknown');
  const output = await pi.flow(`start ${f.spec.number}`, true);
  assert.match(output, /REMOTE_RESULT_UNKNOWN/);
  assert.match(output, /FAULT_APPLIED: push-unknown/);
  assert.doesNotMatch(output, /AGENT_STARTED:|TICKET_PR:|FLOW_STARTED:/);
  assert.equal(fixed.requests.length, 0);
  const feature = api(`repos/${repository}/branches/${encodeURIComponent(f.feature)}`);
  assert.equal(feature.commit.sha, f.baseline, 'remote accepted the real create-only feature push');
  assert.deepEqual(await counts(pi), { phase: 'push-unknown', attempts: 1, applied: 1 });
  assert.match(await pi.flow('status'), /stopping/);
  const boundary = pi.notices.length;
  assert.equal((await pi.request('new_session')).success, true);
  assert.match(pi.notices.slice(boundary).join('\n'), /FLOW_STOPPING:.*ownership retained/);
  const competitorRoot = await mkdtemp(join(tmpdir(), 'flow-fault-competitor-'));
  const competitorProject = join(competitorRoot, 'project');
  execFileSync('git', ['clone', '--quiet', `https://github.com/${repository}.git`, competitorProject], { stdio: 'pipe', timeout: 120_000 });
  const competitor = await openPi(competitorProject, join(f.project, '..', 'agent'), { model: fixed.model, timeoutMs: 120_000 });
  try {
    assert.match(await competitor.flow(`start ${f.spec.number}`, false), /FLOW_OWNED/);
    assert.equal(api(`repos/${repository}/branches/${encodeURIComponent(f.feature)}`).commit.sha, f.baseline);
    assert.deepEqual(await counts(pi), { phase: 'push-unknown', attempts: 1, applied: 1 }, 'unknown write was never retried');
  } finally {
    await competitor.close();
    await rm(competitorRoot, { recursive: true, force: true });
  }
  noTicketDelivery(f);
  assert.equal(f.worktrees().length, 1, 'no Ticket workspace or model dispatch after unknown feature write');
  f.pass({ boundary: 'Real pi/SDK/GitHub; real accepted Git push followed by injected client exit 1 and unavailable exact-ref controller readback; external read verifies the applied branch',
    featureSha: feature.commit.sha, modelRequests: 0, commandFault: { phase: 'push-unknown', attempts: 1, applied: 1 },
    assertions: ['real remote branch exists at baseline', 'unknown result classified', 'exactly one write attempt', 'session change reports stopping', 'ownership retained', 'competing clone refused', 'no Ticket dispatch or PR', 'Issues open', 'remote main and original checkout unchanged'] });
});

test.after(persist);
