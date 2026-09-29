import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairFixture, readFailure, verifyRepairChain } from './repair-fixture.mjs';

const selected = process.env.FLOW_REPAIR_SCENARIO;
const options = scenario => ({ skip: process.env.RUN_GITHUB_E2E !== '1' || (selected && selected !== scenario), timeout: 2_400_000 });

test('real OpenAI repairs an evidenced defect in the same Ticket PR', options('real-repair'), async t => {
  const f = await repairFixture(t, 'real-repair');
  const result = await f.run();
  assert.equal(result.status, 'delivered');
  assert.equal(result.ticketPulls.length, 1);
  assert.ok(result.repairs.length >= 1);
  assert.deepEqual(result.repairModel, { provider: 'openai', id: 'gpt-6-astra' });
  for (const failure of result.failures) readFailure(f, failure);
  await verifyRepairChain(f, result);
  f.verifyRemoteBehavior(result.M);
  f.verifyInvariants('closed');
  f.pass(result, ['real selected OpenAI repair and independent review', 'same PR with appended commits', 'verified failure bytes precede repair', 'independent segment proof and final remote CLI behavior', 'Ticket closed; Spec open; total Draft; main unchanged']);
});

test('five verified repairs continue without a repair-count limit', options('progressive-five'), async t => {
  const f = await repairFixture(t, 'progressive-five');
  const result = await f.run();
  assert.equal(result.status, 'delivered');
  assert.equal(result.ticketPulls.length, 1);
  assert.equal(result.repairs.length, 5);
  assert.equal(result.deferredReads.length, 2, 'two real GET responses exposed the deterministic null/old-C boundary');
  assert.ok(result.candidateWaits.filter(wait => wait.H === result.repairs[0].after).length >= 2);
  for (const deferred of result.deferredReads) {
    assert.equal(deferred.H, result.repairs[0].after);
    assert.ok(result.candidateWaits.some(wait => wait.H === deferred.H));
    assert.ok(!result.gates.some(gate => gate.sha === deferred.oldC), 'old failing C never gains approval while the new H is pending');
  }
  const reports = result.failures.map(failure => readFailure(f, failure));
  assert.deepEqual(reports.map(report => report.behavior.assertions.filter(row => !row.passed).length), [5, 4, 3, 2, 1]);
  const firstNames = reports[0].behavior.assertions.map(row => row.name).sort();
  for (const report of reports) assert.deepEqual(report.behavior.assertions.map(row => row.name).sort(), firstNames);
  await verifyRepairChain(f, result);
  f.verifyRemoteBehavior(result.M); f.verifyInvariants('closed');
  f.pass(result, ['five actual CLI defects resolved individually', 'all assertion identities retained', 'same PR; no fixed repair-count budget', 'each changed version independently gated and reviewed', 'complete segment proof and failure artifacts retained']);
});

for (const scenario of ['no-progress-no-diff', 'no-progress-noise']) {
  test(`repeated failure stops with preserved evidence: ${scenario}`, options(scenario), async t => {
    const f = await repairFixture(t, scenario);
    const result = await f.run();
    assert.equal(result.status, 'no-progress'); assert.equal(result.ticketPulls.length, 1);
    assert.equal(result.repairPrompts, 1, 'no mechanical redispatch after evidence shows no progress');
    assert.equal(result.mergeRequests.length, 0); assert.equal(result.closeRequests.length, 0);
    assert.equal(result.repairs.length, scenario === 'no-progress-no-diff' ? 0 : 1);
    const failures = result.failures.map(failure => readFailure(f, failure));
    assert.ok(failures.length >= 1);
    if (scenario === 'no-progress-noise') assert.deepEqual(failures[1].behavior.assertions, failures[0].behavior.assertions);
    await verifyRepairChain(f, result); f.verifyInvariants('open');
    f.pass(result, ['no-progress derives from actual unchanged defect evidence', 'no empty commit or duplicate PR', 'no merge/closure or late redispatch', 'failure artifacts and owned code retained']);
  });
}

test('text and semantic conflicts are repaired through the same open PR', options('conflict-repair'), async t => {
  const f = await repairFixture(t, 'conflict-repair');
  const result = await f.run();
  assert.equal(result.status, 'delivered');
  assert.ok(result.proof.segments.some(segment => segment.kind === 'controller-merge' && segment.preparation.conflicts.length));
  assert.ok(result.failures.some(failure => failure.kind === 'behavior'));
  assert.equal(result.ticketPulls.length, 1);
  await verifyRepairChain(f, result);
  f.verifyRemoteBehavior(result.M); f.verifyInvariants('closed');
  f.pass(result, ['latest accepted base used', 'real text conflict preparation independently recomputed', 'actual combined CLI exposes semantic defect', 'upstream merge is not fabricated Agent writes', 'same PR appended; complete C/M gates and review']);
});

test('repair ambiguity preserves the existing PR and asks before editing', options('repair-needs-decision'), async t => {
  const f = await repairFixture(t, 'repair-needs-decision');
  const result = await f.run();
  assert.equal(result.status, 'blocked'); assert.equal(result.ticketPulls.length, 1);
  assert.equal(result.repairs.length, 0); assert.equal(result.repairPrompts, 1);
  assert.equal(result.mergeRequests.length, 0); assert.equal(result.closeRequests.length, 0);
  assert.ok(result.question.url && result.question.body.includes('decision'));
  for (const failure of result.failures) readFailure(f, failure);
  f.verifyInvariants('open');
  f.pass(result, ['existing PR/head and failure evidence preserved', 'question recorded without repair edits', 'no invented requirement interpretation', 'no merge or closure']);
});

test('independent review resolves stable blocker references across repairs', options('review-progress'), async t => {
  const f = await repairFixture(t, 'review-progress');
  const result = await f.run();
  assert.equal(result.status, 'delivered'); assert.equal(result.ticketPulls.length, 1);
  const failures = result.failures.map(item => readFailure(f, item));
  assert.equal(failures[0].review.blockers.length, 2);
  assert.ok(failures[1].review.resolutions.some(item => item.status === 'resolved' && item.evidence.length));
  assert.ok(failures[1].review.resolutions.some(item => item.status === 'unresolved'));
  await verifyRepairChain(f, result); f.verifyRemoteBehavior(result.M); f.verifyInvariants('closed');
  f.pass(result, ['stable previous blocker references never disappear by rewording', 'independent raw-blob resolution evidence', 'same PR appends real repairs and gates every version']);
});
