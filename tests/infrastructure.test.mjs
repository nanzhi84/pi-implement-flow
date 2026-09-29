import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, fixture, fixedProvider, persist, repository, waitFor } from './execution-fixture.mjs';
import { infrastructureProvider } from './infrastructure-provider.mjs';
import { implementationFiles, integrationProvider } from './integration-provider.mjs';

export const names = ['model-transient', 'model-exhausted', 'model-permanent', 'model-quota', 'model-invalid', 'model-cancel-retry',
  'github-eof', 'github-permanent', 'gate-behavior', 'gate-infrastructure', 'gate-configuration', 'gate-unclassified',
  'gate-invalid-report', 'gate-success-contradiction', 'gate-timeout-report'];
const selected = process.env.FLOW_INFRASTRUCTURE_SCENARIO;
const options = name => ({ skip: process.env.RUN_GITHUB_E2E !== '1' || (selected && selected !== name), timeout: 1_200_000 });
function detail(pi) {
  const notice = pi.notices.findLast(message => message.startsWith('FAILURE_DETAIL: '));
  return notice ? JSON.parse(notice.slice('FAILURE_DETAIL: '.length)) : undefined;
}
function noRepair(f) {
  const children = api(`repos/${repository}/issues/${f.spec.number}/sub_issues`);
  assert.deepEqual(children.map(issue => issue.number), [f.ticket.number], 'infrastructure never creates repair Tickets');
  f.verifyInvariants();
}
function safe(pi) { assert.ok(!pi.notices.join('\n').includes('FLOW_SYNTHETIC_SECRET_DO_NOT_PUBLISH')); }
const modelExpected = {
  'model-transient': { count: 2, code: 'TICKET_BLOCKED' },
  'model-exhausted': { count: 3, code: 'AGENT_FAILED', kind: 'infrastructure', reason: 'service-unavailable' },
  'model-permanent': { count: 1, code: 'AGENT_FAILED', kind: 'configuration', reason: 'authentication' },
  'model-quota': { count: 1, code: 'AGENT_FAILED', kind: 'configuration', reason: 'quota-exhausted' },
  'model-invalid': { count: 1, code: 'AGENT_RESULT_INVALID' },
  'model-cancel-retry': { count: 1, code: 'FLOW_PAUSED' },
};
for (const [scenario, expected] of Object.entries(modelExpected)) {
  test(`real SDK recovery boundary: ${scenario}`, options(scenario), async t => {
    const fixed = await infrastructureProvider(t, scenario);
    const f = await fixture(t, scenario, { fixed, preserveOnPass: true, stage: 'T9A',
      ticketRequest: 'This synthetic Ticket intentionally leaves greeting wording unresolved. Ask which wording is required and do not edit, commit or deliver code. The transport fixture verifies supported bounded SDK recovery.' });
    const pi = await f.open();
    const contract = JSON.parse(await readFile(join(f.project, '.pi/flow.json'), 'utf8'));
    assert.deepEqual(contract.agents.retry, { enabled: true, maxRetries: 2, providerMaxRetries: 0 });
    const running = pi.flow(`start ${f.spec.number}`, true);
    if (scenario === 'model-cancel-retry') {
      await waitFor(() => pi.notices.some(message => message.startsWith('MODEL_RETRY: ')), 'SDK retry did not reach its cancellation boundary', 600_000);
      assert.equal((await pi.request('new_session')).success, true);
    }
    const output = await running; fixed.assertHealthy();
    assert.match(output, new RegExp(expected.code));
    assert.equal(fixed.requests.length, expected.count, 'no control-layer loop after the SDK policy or cancellation');
    if (expected.kind) assert.deepEqual({ kind: detail(pi)?.kind, reason: detail(pi)?.reason, operation: detail(pi)?.operation },
      { kind: expected.kind, reason: expected.reason, operation: 'implementation-model' });
    assert.equal(pi.notices.filter(message => message.startsWith('AGENT_STARTED: ')).length, 1);
    f.verifyNoDiff(); noRepair(f); safe(pi);
    f.pass({ modelRequests: fixed.requests.length, httpStatuses: fixed.requests.map(request => request.status), failure: detail(pi),
      assertions: ['real pi role and installed SDK used', 'request count matches the bounded SDK outcome without outer retry',
        'permanent, invalid-result and cancelled results do not authorize delivery', 'no source edit, empty commit or Ticket PR',
        'no repair Ticket; Issues open; main unchanged', 'raw provider diagnostic sentinel absent from notifications'] });
  });
}
const commands = {
  'github-eof': ['REMOTE_READ_FAILED', 'infrastructure', 'eof', 'github-read'],
  'github-permanent': ['REMOTE_READ_FAILED', 'configuration', 'permission', 'github-read'],
  'gate-behavior': ['BEHAVIOR_FAILED'],
  'gate-infrastructure': ['COMMAND_FAILED', 'infrastructure', 'connection-refused', 'accept'],
  'gate-configuration': ['COMMAND_FAILED', 'configuration', 'missing-dependency', 'accept'],
  'gate-unclassified': ['COMMAND_FAILED', 'unknown', 'process-exited', 'accept'],
  'gate-invalid-report': ['COMMAND_REPORT_INVALID'],
  'gate-success-contradiction': ['COMMAND_REPORT_INVALID'],
  'gate-timeout-report': ['COMMAND_TIMEOUT', 'unknown', 'timeout', 'accept'],
};
for (const [scenario, expected] of Object.entries(commands)) {
  test(`real command failure boundary: ${scenario}`, options(scenario), async t => {
    const gate = scenario.startsWith('gate-');
    const fixed = gate ? await integrationProvider(t, scenario)
      : await fixedProvider(t, { kind: 'implemented', summary: 'No model request expected for a failed remote planning read.' });
    const f = await fixture(t, scenario, { fixed, stage: 'T9A', preserveOnPass: true,
      ticketRequest: 'Add executable whitespace-only-rejected CLI acceptance before implementation in fixture.mjs, retaining every existing assertion. Reject name.trim() === empty in app.mjs; otherwise preserve exact greeting behavior. Only app.mjs and fixture.mjs may change. Stop if a trusted gate cannot complete. Do not change the contract, instructions, publisher or main.' });
    if (gate) fixed.setImplementation(await implementationFiles(f.project));
    const pi = await f.open({ extensions: [fileURLToPath(new URL('./fixtures/infrastructure-bridge.mjs', import.meta.url))] });
    assert.equal((await pi.request('prompt', { message: `/fixture-infrastructure ${JSON.stringify({ mode: scenario, repository, spec: f.spec.number })}` })).success, true);
    const output = await pi.flow(`start ${f.spec.number}`, true); fixed.assertHealthy?.();
    assert.match(output, new RegExp(`${expected[0]}:`));
    assert.equal((await pi.request('prompt', { message: '/fixture-infrastructure-status' })).success, true);
    const observer = JSON.parse(pi.notices.findLast(message => message.startsWith('INFRASTRUCTURE_OBSERVER: ')).slice('INFRASTRUCTURE_OBSERVER: '.length));
    assert.equal(observer.attempts, 1); assert.equal(observer.applied, 1, 'actual command/read completed before the explicit boundary fault');
    if (expected[1]) assert.deepEqual({ kind: detail(pi)?.kind, reason: detail(pi)?.reason, operation: detail(pi)?.operation },
      { kind: expected[1], reason: expected[2], operation: expected[3] });
    if (!gate) assert.equal(fixed.requests.length, 0);
    else {
      assert.equal(fixed.requests.filter(request => request.role === 'review').length, 0, 'failed gate cannot be approved by a reviewer');
      const pulls = f.pulls(); assert.equal(pulls.length, 1); assert.equal(pulls[0].state, 'open'); assert.equal(pulls[0].merged_at, null);
      assert.equal(api(`repos/${repository}/git/ref/heads/${f.feature}`).object.sha, f.baseline);
      assert.match(observer.report.codeSha, /^[a-f0-9]{40}$/); assert.match(observer.report.reportDigest, /^[a-f0-9]{64}$/);
      if (scenario === 'gate-behavior') {
        const notice = pi.notices.find(message => message.startsWith('BEHAVIOR_FAILURE: ')); assert.ok(notice);
        const report = JSON.parse(notice.slice('BEHAVIOR_FAILURE: '.length));
        assert.equal(report.command, 'accept'); assert.equal(report.codeSha, observer.report.codeSha); assert.equal(report.reportDigest, observer.report.reportDigest);
        assert.deepEqual(report.assertions, [{ name: 'greeting-for-name', passed: true }, { name: 'synthetic-required-behavior', passed: false }]);
      } else assert.ok(!pi.notices.some(message => message.startsWith('BEHAVIOR_FAILURE: ')));
    }
    assert.doesNotMatch(output, /TICKET_DELIVERED:/); noRepair(f); safe(pi);
    f.pass({ failure: detail(pi), boundaryObservation: observer,
      assertions: ['real pi and actual GitHub/project command boundary', 'one command attempt with no outer replay',
        'strict failed-behavior envelope stays distinct from infrastructure/configuration/unknown', 'lifecycle outcome takes precedence over earlier stdout',
        'no merge or close; no repair Ticket; source and main preserved', 'raw diagnostic sentinel absent from notifications'] });
  });
}
test.after(persist);
