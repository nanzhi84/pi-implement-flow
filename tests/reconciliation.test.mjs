import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, featureSha, integrationFixture, readGate, repository, ticketPull, totals,
  verifyRemoteBehavior, verifyVersionChain } from './integration-fixture.mjs';
import { persist } from './execution-fixture.mjs';

const names = ['applied-responses-lost', 'push-not-sent', 'push-read-not-started', 'pr-read-unavailable', 'pr-read-orphaned', 'merge-read-unavailable',
  'publisher-partial', 'publisher-bytes-mismatch', 'publisher-source-drift', 'publisher-wrong-tag', 'derived-association-lost', 'derived-association-drift', 'derived-create-unresolved'];
const selected = process.env.FLOW_RECONCILIATION_SCENARIO;
const options = name => ({ skip: process.env.RUN_GITHUB_E2E !== '1' || (selected && selected !== name), timeout: 1_800_000 });
const bridge = fileURLToPath(new URL('./fixtures/reconciliation-bridge.ts', import.meta.url));
async function setup(t, scenario) {
  assert.equal(repository, 'nanzhi84/pi-implement-flow-reconciliation-acceptance');
  assert.equal(process.env.PI_PROVIDER, 'openai'); assert.equal(process.env.PI_MODEL, 'gpt-6-astra');
  assert.equal(api(`repos/${repository}/branches/main`).commit.sha, 'afaa997f3859680d01ea8e88fd0344803f8b398a');
  const f = await integrationFixture(t, scenario, { stage: 'T9B', real: scenario === 'applied-responses-lost', observerMode: 'observe', extensions: [bridge] });
  assert.deepEqual(f.contract.artifacts.locator, { kind: 'github-release', tagPrefix: 'flow-evidence', assetName: 'evidence.json' });
  assert.equal((await f.pi.request('prompt', { message: `/fixture-reconciliation ${JSON.stringify({ repository,
    mode: scenario, spec: f.spec.number, ticket: f.ticket.number })}` })).success, true);
  f.fault = async () => {
    const start = f.pi.notices.length;
    assert.equal((await f.pi.request('prompt', { message: '/fixture-reconciliation-status' })).success, true);
    const notice = f.pi.notices.slice(start).find(item => item.startsWith('RECONCILIATION_OBSERVER: '));
    assert.ok(notice); return JSON.parse(notice.slice('RECONCILIATION_OBSERVER: '.length));
  };
  return f;
}
test('real OpenAI flow reconciles applied writes without repeating semantic delivery', options(names[0]), async t => {
  const f = await setup(t, names[0]); const output = await f.run();
  assert.match(output, /TICKET_DELIVERED:/);
  const observed = await f.observer(); const fault = await f.fault();
  const c = readGate(f, observed.gates.find(item => item.phase === 'candidate'));
  const pr = ticketPull(f); const versions = verifyVersionChain(f, pr, c);
  const m = readGate(f, observed.gates.find(item => item.phase === 'actual'));
  assert.equal(m.report.codeSha, versions.M); assert.deepEqual(m.report.versions, versions);
  assert.deepEqual(m.report.approvedContext, c.report.approvedContext);
  verifyRemoteBehavior(f, versions.M); f.verifyInvariants('closed');
  const total = totals(f); assert.equal(total.length, 1); assert.equal(total[0].draft, true); assert.equal(total[0].head.sha, versions.M);
  assert.equal(fault.attempts.length, fault.applied.length);
  assert.equal(new Set(fault.attempts.map(item => item.key)).size, fault.attempts.length);
  for (const kind of ['push:', 'create-pr:', 'ready:', 'merge:', 'comment:', 'close:', 'publish:']) {
    assert.ok(fault.applied.some(item => item.key.startsWith(kind)), `real ${kind} applied before response loss`);
  }
  assert.equal(fault.attempts.filter(item => item.key.startsWith('merge:')).length, 1);
  assert.equal(fault.attempts.filter(item => item.key.startsWith('close:')).length, 1);
  const comments = api(`repos/${repository}/issues/${f.ticket.number}/comments`);
  assert.equal(comments.filter(item => item.body.includes('Ticket delivery evidence')).length, 1);
  f.pass({ versions, ticketPr: pr.html_url, totalPr: total[0].html_url, fault,
    evidence: [c, m].map(item => ({ url: item.url, sha256: item.sha256, codeSha: item.report.codeSha })),
    assertions: ['real OpenAI implementation and independent C/M reviews', 'real successful commands precede lost responses',
      'one attempt per exact write target; no second merge or duplicate PR/comment', 'actual C/M parents/tree/CLI and raw asset bytes verified',
      'matching approved context retained', 'Ticket closed after actual evidence; total Draft; parent open; main unchanged'] });
});
for (const scenario of names.filter(name => ['push-not-sent', 'push-read-not-started', 'pr-read-unavailable', 'pr-read-orphaned', 'merge-read-unavailable'].includes(name))) {
  test(`real flow safely stops when ${scenario}`, options(scenario), async t => {
    const f = await setup(t, scenario); const output = await f.run(); const fault = await f.fault();
    assert.doesNotMatch(output, /TICKET_DELIVERED:/); assert.equal(fault.attempts.length, 1);
    if (scenario === 'push-not-sent') {
      assert.match(output, /REMOTE_NOT_SENT/); assert.equal(fault.applied.length, 0); assert.equal(f.fixed.requests.length, 0);
      assert.equal(api(`repos/${repository}/git/matching-refs/heads/${f.feature}`).length, 0); assert.equal(f.pulls().length, 0);
    } else if (scenario === 'push-read-not-started') {
      assert.match(output, /REMOTE_RESULT_UNKNOWN/); assert.doesNotMatch(output, /REMOTE_NOT_SENT/);
      assert.equal(fault.applied.length, 1); assert.equal(featureSha(f), f.baseline);
      assert.equal(f.pulls().length, 0); assert.equal(f.fixed.requests.length, 0);
      assert.match(await f.pi.flow('status'), /stopping/);
    } else {
      if (scenario === 'pr-read-orphaned') {
        if (output.includes('PROCESS_UNQUIESCED:')) assert.match(output, /"kind":"unquiesced"/);
        else { assert.match(output, /REMOTE_RESULT_UNKNOWN/); assert.match(output, /COMMAND_ORPHANED/); }
        assert.equal(fault.queryAttempts, 1);
      } else assert.match(output, /REMOTE_RESULT_UNKNOWN/);
      assert.equal(fault.applied.length, 1);
      assert.ok(fault.queryAttempts >= 1, 'the exact post-write read fault was reached');
      const pr = ticketPull(f);
      assert.equal(pr.merged, scenario === 'merge-read-unavailable');
      if (pr.merged) assert.equal(featureSha(f), pr.merge_commit_sha);
      else assert.equal(featureSha(f), f.baseline);
      assert.equal(f.pulls().length, 1); assert.equal(totals(f).length, 0);
      assert.match(await f.pi.flow('status'), /stopping/);
    }
    f.verifyInvariants();
    f.pass({ fault, assertions: ['one write attempt with actual remote outcome independently read',
      'no delivery or Ticket closure', 'unknown query is not negative proof; no ordinary retry', 'Spec open; main unchanged; source retained'] });
  });
}
for (const scenario of names.filter(name => name.startsWith('publisher-'))) {
  test(`preflight refuses ${scenario} at the exact artifact locator`, options(scenario), async t => {
    const f = await setup(t, scenario); const output = await f.run(); const fault = await f.fault();
    const expected = {
      'publisher-source-drift': /PROBE_CHANGED_CODE: Project probes changed code/,
      'publisher-partial': /PUBLISH_UNRESOLVED: The exact release exists without a completed artifact/,
      'publisher-bytes-mismatch': /EVIDENCE_INVALID: Raw artifact bytes differ/,
      'publisher-wrong-tag': /EVIDENCE_INVALID: Actual Git tag does not resolve/,
    };
    assert.match(output, expected[scenario]);
    assert.equal(fault.attempts.length, 1); assert.equal(fault.applied.length, 1); assert.equal(f.fixed.requests.length, 0);
    const release = api(`repos/${repository}/releases/tags/${fault.applied[0].tag}`);
    assert.equal(release.assets.length, scenario === 'publisher-partial' ? 0 : 1);
    const probe = f.worktrees().find(path => path !== f.project); assert.ok(probe);
    const original = await readFile(join(dirname(probe), 'resources', 'evidence.json'));
    const report = JSON.parse(original); assert.equal(report.codeSha, f.baseline);
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.equal(fault.applied[0].tag, `flow-evidence-${hash(original)}`);
    if (scenario !== 'publisher-partial') {
      const bytes = execFileSync('gh', ['release', 'download', fault.applied[0].tag, '--repo', repository,
        '--pattern', 'evidence.json', '--output', '-'], { stdio: 'pipe', timeout: 120_000 });
      assert.equal(bytes.length, original.length);
      assert.deepEqual(JSON.parse(bytes), report);
      if (scenario === 'publisher-bytes-mismatch') assert.notEqual(hash(bytes), hash(original));
      else assert.equal(hash(bytes), hash(original));
      const actual = api(`repos/${repository}/git/ref/tags/${fault.applied[0].tag}`);
      assert.equal(actual.object.type, 'commit');
      assert.equal(actual.object.sha, scenario === 'publisher-wrong-tag' ? '485b0ddfecbfed0fc6248fdad63454c792902f03' : f.baseline);
    }
    assert.equal(f.pulls().length, 0); f.verifyInvariants();
    f.pass({ fault, release: release.html_url, assertions: ['actual content-addressed remote release preserved',
      'missing/wrong raw asset does not qualify', 'publisher runs once; no upload replay or overwrite',
      'no model dispatch or Ticket PR; parent and Ticket open; main unchanged'] });
  });
}
for (const scenario of names.filter(name => name.startsWith('derived-'))) {
  test(`real pi remote adapter handles ${scenario} without duplicate children`, options(scenario), async t => {
    const f = await setup(t, scenario);
    const start = f.pi.notices.length;
    assert.equal((await f.pi.request('prompt', { message: '/fixture-reconciliation-derived' })).success, true);
    const output = f.pi.notices.slice(start).join('\n'); const fault = await f.fault();
    assert.equal(fault.attempts.length, 1); assert.equal(fault.applied.length, 1);
    const children = api(`repos/${repository}/issues/${f.spec.number}/sub_issues`);
    if (scenario === 'derived-association-lost') {
      assert.match(output, /DERIVED_CONFIRMED: (\d+)/); const number = Number(/DERIVED_CONFIRMED: (\d+)/.exec(output)[1]);
      assert.equal(children.length, 2); assert.equal(children.filter(item => item.number === number).length, 1);
    } else if (scenario === 'derived-association-drift') {
      assert.match(output, /DERIVED_STOPPED: REMOTE_RESULT_UNKNOWN/); assert.equal(children.length, 2);
      const child = children.find(item => item.number === fault.applied[0].number);
      assert.equal(child?.id, fault.applied[0].id); assert.equal(child?.state, 'closed');
      assert.notEqual(child.number, f.spec.number); assert.notEqual(child.number, f.ticket.number);
      assert.equal(api(`repos/${repository}/issues/${child.number}`).state_reason, 'not_planned');
    } else {
      assert.match(output, /DERIVED_STOPPED: REMOTE_RESULT_UNKNOWN/); assert.equal(children.length, 1);
      const orphan = api(`repos/${repository}/issues/${fault.applied[0].number}`);
      assert.equal(orphan.state, 'open'); assert.equal(orphan.pull_request, undefined);
    }
    f.verifyInvariants(); assert.equal(f.fixed.requests.length, 0);
    f.pass({ fault, boundary: 'Real pi test command invokes the production remote adapter; full automatic derived-work flow belongs to later Tickets',
      assertions: ['one actual Issue create; no title matching or duplicate child', 'exact native association reused only when identity known',
        'lost unassociated identity stays unresolved', 'existing Spec/Ticket/main unchanged; no model or implementation'] });
  });
}
test.after(persist);
