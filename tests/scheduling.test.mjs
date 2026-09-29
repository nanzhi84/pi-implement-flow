import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphFixture, verifyDelivery, verifyNoDelivery, verifyActivities, names } from './scheduling-fixture.mjs';

const selected = process.env.FLOW_SCHEDULING_SCENARIO;
const options = name => ({ skip: process.env.RUN_GITHUB_E2E !== '1' || (selected && selected !== name), timeout: 2_700_000 });

test('real OpenAI A/B implementation overlaps and C starts only from both actual deliveries', options('real-openai-diamond'), async t => {
  assert.equal(process.env.PI_PROVIDER, 'openai'); assert.equal(process.env.PI_MODEL, 'gpt-6-astra');
  assert.ok(process.env.PI_BIN);
  const f = await graphFixture(t, names[0]);
  const output = await f.run(); const observed = await f.observe();
  verifyActivities(observed, 2);
  const role = ticket => observed.activities.filter(item => item.ticket === ticket && item.kind === 'implementation');
  const aRole = role(f.tickets.A.number); const bRole = role(f.tickets.B.number);
  assert.equal(aRole.length, 2); assert.equal(bRole.length, 2);
  assert.ok(aRole[0].sequence < bRole[1].sequence && bRole[0].sequence < aRole[1].sequence, 'actual OpenAI role lifetimes overlap');
  assert.equal(observed.resources.isolatedPairs.length, 1, 'two actual command-owned servers overlap');
  const pair = observed.resources.isolatedPairs[0];
  assert.notEqual(pair[0].port, pair[1].port); assert.equal(pair[0].key, pair[1].key);
  assert.notEqual(pair[0].value, pair[1].value);
  for (const item of pair) assert.equal(item.received, item.value, 'same logical key remains scoped to its owner');
  const a = await verifyDelivery(f, 'A'); const b = await verifyDelivery(f, 'B'); const c = await verifyDelivery(f, 'C');
  const cStart = observed.starts.find(item => item.ticket === f.tickets.C.number);
  assert.ok(cStart);
  for (const prior of [a, b]) {
    assert.ok(f.isAncestor(prior.M, cStart.sha), 'C starts from feature history containing accepted dependency M');
    assert.ok(observed.deliveries.find(item => item.ticket === prior.ticket).sequence < cStart.sequence);
  }
  assert.equal(c.B, cStart.sha);
  await f.verifyRemote(c.M, 'combined.mjs', ['Ada', '2'], 'HELLO, Ada!\nHello, Ada!\nHello, Ada!\n');
  await f.verifyEnd();
  assert.match(output, /final-acceptance-not-installed/);
  f.pass({ deliveries: [a, b, c], resources: observed.resources, assertions: [
    'real OpenAI A/B roles overlap through actual approved prepare commands', 'same key and distinct real ports/data remain isolated',
    'C starts after both verified M deliveries with their ancestry', 'latest candidates and actual versions receive gates',
    'remote combined CLI correct; Spec open; total Draft; main unchanged',
  ] });
});

test('review queues release slots; local ambiguity and overlapping files do not add dependencies', options('slot-release-and-local-block'), async t => {
  const f = await graphFixture(t, names[1]); const output = await f.run(); const observed = await f.observe();
  verifyActivities(observed, 2);
  assert.ok(observed.submittedBeforeFirstReview >= 2, 'two implementations can finish and wait without retaining compute slots');
  const a = await verifyDelivery(f, 'A'); const b = await verifyDelivery(f, 'B');
  await verifyNoDelivery(f, 'D'); await verifyNoDelivery(f, 'E');
  assert.ok(observed.starts.some(item => item.ticket === f.tickets.D.number));
  assert.ok(!observed.starts.some(item => item.ticket === f.tickets.E.number));
  assert.match(output, /TICKET_BLOCKED:/);
  assert.deepEqual(await f.nativeDependencies('A'), []); assert.deepEqual(await f.nativeDependencies('B'), []);
  assert.ok(f.changedPaths(a.H).includes('fixture.mjs') && f.changedPaths(b.H).includes('fixture.mjs'));
  await f.verifyEnd();
  f.pass({ deliveries: [a, b], assertions: ['queued integrations hold no compute slots', 'review uses same capacity',
    'unrelated Tickets deliver despite D ambiguity', 'E remains blocked', 'overlapping files do not invent native dependencies'] });
});

test('exclusive shared resource remains owned until cleanup including review waits', options('exclusive-real-resource'), async t => {
  const f = await graphFixture(t, names[2]); await f.run(); const observed = await f.observe();
  verifyActivities(observed, 2);
  assert.equal(observed.resources.conflicts.length, 0);
  assert.ok(observed.resources.leases.length >= 6, 'implementation and both exact gates actually acquire shared resources');
  for (const [index, lease] of observed.resources.leases.entries()) {
    assert.ok(lease.released > lease.acquired);
    if (index) assert.ok(lease.acquired > observed.resources.leases[index - 1].released);
  }
  assert.ok(observed.resources.reviewWhileHeld, 'a review wait does not release prepared resource ownership');
  const a = await verifyDelivery(f, 'A'); const b = await verifyDelivery(f, 'B'); await f.verifyEnd();
  f.pass({ deliveries: [a, b], resources: observed.resources, assertions: ['real shared namespace serializes from prepare through cleanup',
    'review waits retain resource lease', 'resource wait does not consume compute', 'harness service ownership is explicit'] });
});

test('B is revalidated on latest accepted A and semantic failure cannot reuse old success', options('latest-base-semantic-conflict'), async t => {
  const f = await graphFixture(t, names[3]); const output = await f.run(); const observed = await f.observe();
  verifyActivities(observed, 2);
  const a = await verifyDelivery(f, 'A'); const b = await verifyNoDelivery(f, 'B');
  assert.equal(await f.branchHead(), a.M);
  const attempted = observed.candidates.find(item => item.ticket === f.tickets.B.number);
  assert.ok(attempted); assert.equal(attempted.B, a.M);
  assert.equal(await f.verifyOldBaseBehavior(b.head.sha), true, 'B alone really satisfies its original local behavior');
  assert.ok(observed.commands.some(item => item.sha === attempted.C && item.phase === 'candidate' && item.command === 'accept' && item.exitCode !== 0));
  assert.ok(!observed.merges.some(item => item.ticket === f.tickets.B.number));
  assert.doesNotMatch(output, new RegExp(`TICKET_DELIVERED: #${f.tickets.B.number} `));
  await f.verifyEnd();
  f.pass({ delivery: a, refusedHead: b.head.sha, candidate: attempted, assertions: ['B old starting tree passes external behavior',
    'candidate uses latest accepted A base', 'actual composed behavior fails despite no textual conflict', 'no B merge/closure or stale eligibility'] });
});

test('unknown push freezes parallel work while failed cleanup retains its resource and ownership', options('parallel-unknown-retains-cleanup'), async t => {
  const f = await graphFixture(t, 'parallel-unknown-retains-cleanup');
  const running = f.run();
  await Promise.race([f.waitCleanupHold(), running.then(() => { throw new Error('Flow ended before the intentional parallel cleanup boundary'); })]);
  const held = await f.observe(); verifyActivities(held, 2, true);
  assert.ok(held.resources.unknownPush, 'the remote push really applied before the transport fault');
  const before = held.events.filter(item => item.type === 'notice' && item.message.startsWith('FLOW_RESOURCE: ')).map(item => JSON.parse(item.message.slice('FLOW_RESOURCE: '.length)));
  assert.ok(!before.some(item => item.ticket === f.tickets.B.number && item.event === 'released'));
  const competitor = await f.open();
  assert.match(await competitor.flow(`start ${f.spec.number}`, true), /FLOW_OWNED:/);
  f.releaseCleanup();
  const output = await running; const observed = await f.observe(); verifyActivities(observed, 2);
  assert.match(output, /REMOTE_RESULT_UNKNOWN:/); assert.match(await f.status(), /stopping/);
  const resources = observed.events.filter(item => item.type === 'notice' && item.message.startsWith('FLOW_RESOURCE: ')).map(item => JSON.parse(item.message.slice('FLOW_RESOURCE: '.length)));
  assert.ok(resources.some(item => item.ticket === f.tickets.B.number && item.event === 'retained'));
  assert.ok(!resources.some(item => item.ticket === f.tickets.B.number && item.event === 'released'));
  assert.equal(observed.events.filter(item => item.type === 'git-write').length, 2);
  assert.equal(observed.events.filter(item => item.type === 'github-write').length, 0);
  assert.ok(observed.commands.some(item => item.ticket === f.tickets.B.number && item.command === 'cleanup' && item.exitCode === 1));
  await f.verifyUnknownStop(observed.resources.unknownPush);
  assert.match(await competitor.flow(`start ${f.spec.number}`, true), /FLOW_OWNED:/);
  f.pass({ remotePush: observed.resources.unknownPush, assertions: ['actual remote push preserved once',
    'parallel model result cancelled without another write', 'cleanup uses normal activity capacity after freeze',
    'resource never released before or after failed cleanup', 'controller ownership retained and competitor refused',
    'unknown remains primary; no PR/merge/closure; main and Issues unchanged'] });
});
