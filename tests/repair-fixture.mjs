import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, created, fixture, git, persist, repository, runGreeting } from './execution-fixture.mjs';
import { repairProvider, whitespaceCases } from './repair-provider.mjs';
import { verifyProof } from './repair-proof.mjs';
const expectedRepository = 'nanzhi84/pi-implement-flow-repair-acceptance';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requirement = `Implement blank-name rejection in the greeting CLI. Reject with exit 2 and no stdout if the name is missing, contains CR/LF, or name.trim() === ''; otherwise preserve the accepted name exactly in the Hello greeting. First add actual CLI checks named blank-space-rejected, blank-tab-rejected, blank-form-feed-rejected, blank-nbsp-rejected, blank-em-space-rejected covering respectively space, TAB, form feed, NBSP and U+2003. Preserve every pre-existing assertion and executable check. The five new checks must always execute and produce their actual passed booleans. If any fails, emit exactly one JSON {schema:'flow-command-failure-v1',kind:'behavior',codeSha:process.env.FLOW_CODE_SHA,assertions:[all original and all five new named assertions]} and exit 1; otherwise preserve the existing {passed:true,assertions:[all assertions]} success envelope. Never delete, rename, bypass or weaken a check to obtain success. Only app.mjs and additive fixture.mjs checks/output adaptation may change. Contract, instructions and publisher are immutable. Gates may merge and close only accepted Tickets; keep Spec open, total PR Draft and main unchanged.`;
const diagnosticRequirement = ' Additionally, for rejected blank names stderr must include both the diagnostic blank name and the guidance Usage: app.mjs NAME. These requirements are independent review criteria even before their additive named assertions are added.';
const upstreamRequirement = `UPSTREAM_RESERVED: Reject the exact name Reserved with exit 2 and empty stdout, preserving all other behavior. Before changing app.mjs, add a real CLI assertion reserved-name-rejected and its executable check to fixture.mjs; preserve every old assertion and check. Only those two files may change; contract/instructions/publisher immutable. This is an independent upstream Ticket; do not implement blank rejection here.`;

function download(f, observation) {
  if (f.reportCache.has(observation.url)) return f.reportCache.get(observation.url);
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(observation.url);
  assert.ok(match); assert.equal(match[1], repository);
  const bytes = execFileSync('gh', ['release', 'download', match[2], '--repo', repository, '--pattern', match[3], '--output', '-'], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 16_000_000 });
  if (observation.sha256) assert.equal(hash(bytes), observation.sha256);
  const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.equal(report.repository, repository); assert.equal(report.spec, f.spec.number); assert.equal(report.ticket, f.ticket.number);
  assert.equal(report.codeSha, observation.sha); assert.equal(report.cleanup, 'passed');
  assert.equal(report.scopeDigest, hash(JSON.stringify(f.approved)));
  assert.equal(report.contractDigest, hash(JSON.stringify(f.contract)));
  assert.equal(report.approvedContext.source, 'controller-approved-snapshot');
  assert.equal(report.approvedContext.ticket.body.text, f.ticket.body);
  assert.equal(report.retentionDays >= f.contract.artifacts.retentionDays, true);
  f.reportCache.set(observation.url, report); return report;
}
export function readFailure(f, failure) {
  const report = download(f, failure);
  assert.equal(report.kind, failure.kind === 'text-conflict' ? 'ticket-integration-conflict' : 'ticket-gate-failure');
  assert.equal(report.commandResults.cleanup, 'passed');
  if (failure.kind === 'behavior') {
    assert.equal(report.behavior.codeSha, report.codeSha);
    assert.ok(report.behavior.assertions.some(item => !item.passed));
    assert.equal(new Set(report.behavior.assertions.map(item => item.name)).size, report.behavior.assertions.length);
    assert.equal(report.review.codeSha, report.codeSha); assert.equal(report.review.scopeDigest, report.scopeDigest);
    assert.equal(report.reviewSource.isolation, 'independent-context');
  }
  return report;
}
export async function verifyRepairChain(f, result) {
  const successful = result.gates.map(observation => download(f, observation));
  for (const observation of [...result.failures, ...result.gates]) {
    const report = download(f, observation);
    verifyProof(f.project, report.implementationEvidence, report.codeSha);
  }
  assert.equal(result.proof.origin, f.baseline);
  const heads = [result.proof.origin, ...result.proof.segments.map(segment => segment.head)];
  for (const repair of result.repairs) {
    assert.equal(heads[heads.indexOf(repair.after) - 1], repair.before);
    assert.equal(repair.url, result.ticketPulls[0].html_url);
  }
  const comments = api(`repos/${repository}/issues/${result.ticketPulls[0].number}/comments?per_page=100`);
  for (const failure of result.failures) assert.ok(comments.some(comment => comment.body.includes(failure.url) && comment.body.includes(failure.sha256)), 'failure evidence is linked remotely before repair');
  if (result.M) {
    const pr = api(`repos/${repository}/pulls/${result.ticketPulls[0].number}`);
    assert.equal(pr.merged, true); assert.equal(pr.merge_commit_sha, result.M); assert.equal(pr.head.sha, result.proof.head);
    const actual = api(`repos/${repository}/git/commits/${result.M}`);
    assert.equal(actual.parents[1].sha, result.proof.head);
    const candidate = successful.findLast(report => report.phase === 'candidate'); assert.ok(candidate);
    const accepted = successful.findLast(report => report.codeSha === result.M) ?? candidate;
    assert.equal(accepted.codeSha, result.M, 'actual-version acceptance must exist before closure');
    for (const old of candidate.assertions.filter(item => item.command === 'accept')) {
      assert.ok(accepted.assertions.some(item => item.command === 'accept' && item.name === old.name && item.passed),
        'candidate acceptance IDs must remain observable and passed on the actual merge');
    }
  }
}

export async function repairFixture(t, scenario) {
  assert.equal(repository, expectedRepository, 'repair suite must explicitly select its own isolated remote');
  const identity = api(`repos/${repository}`).id;
  assert.equal(api(`repos/${repository}/branches/main`).commit.sha, '485b0ddfecbfed0fc6248fdad63454c792902f03', 'verify the approved synthetic baseline before any fixture writes');
  const socket = `/tmp/pi-flow-${process.getuid()}-${hash(`github.com:${identity}`).slice(0, 24)}.sock`;
  await assert.rejects(access(socket), { code: 'ENOENT' });
  const fixed = await repairProvider(t, scenario);
  const real = scenario === 'real-repair'; const conflict = scenario === 'conflict-repair';
  const body = requirement + (scenario === 'review-progress' ? diagnosticRequirement : '');
  const f = await fixture(t, scenario, { stage: 'T5', fixed: real ? undefined : fixed, preserveOnPass: true,
    specBody: `## Problem Statement\n\n${body}${conflict ? '\n\nThis Spec also includes an independent upstream Reserved-name rejection Ticket. Preserve its delivered behavior and acceptance when integrating the blank-name Ticket.' : ''}\n\n## Acceptance criteria\n\n- ${body}\n- Every known defect remains linked to complete original failure evidence.\n- Repair in the same open PR without changing requirements.`,
    ticketBody: spec => `## What to build\n\n${conflict ? upstreamRequirement : body}\n\nPart of #${spec}.\n\n## Acceptance criteria\n\n- ${conflict ? upstreamRequirement : body}\n\n## Blocked by\n\nNone`,
  });
  t.after(async () => {
    let before; try { before = await lstat(socket); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    assert.equal(before.isSocket(), true);
    let absent = false; try { execFileSync('lsof', ['-t', socket], { stdio: 'pipe' }); } catch (error) { absent = error.status === 1; }
    assert.equal(absent, true, 'never remove a live/unknown owner');
    assert.equal((await lstat(socket)).ino, before.ino); await rm(socket);
  });
  const upstream = conflict ? f.ticket : undefined;
  let target = f.ticket;
  if (conflict) {
    target = api(`repos/${repository}/issues`, { title: `[Synthetic] T5 blank-name conflict Ticket ${Date.now()}`,
      body: `## What to build\n\n${body}\n\nPart of #${f.spec.number}. Preserve the upstream Reserved-name behavior once it is integrated; the two independent initial branches may conflict.\n\n## Acceptance criteria\n\n- ${body}\n- Preserve reserved-name-rejected and its executable check when combining the latest feature.\n\n## Blocked by\n\nNone` });
    created.push({ scenario, kind: 'ticket', number: target.number, url: target.html_url }); await persist();
    api(`repos/${repository}/issues/${f.spec.number}/sub_issues`, { sub_issue_id: target.id });
  }
  await fixed.configure(f.project, upstream?.number);
  const contract = JSON.parse(await readFile(join(f.project, '.pi/flow.json'), 'utf8'));
  let approved;
  const extensions = [fileURLToPath(new URL('./fixtures/repair-observer.mjs', import.meta.url)),
    ...(real ? [fileURLToPath(new URL('./fixtures/repair-model-bridge.mjs', import.meta.url))] : [])];
  const pi = await f.open({ timeoutMs: 2_400_000, extensions, onConfirm: event => {
    const start = event.message.indexOf('\n{'); assert.ok(start >= 0); approved = JSON.parse(event.message.slice(start + 1)); return true;
  } });
  assert.equal((await pi.request('prompt', { message: `/fixture-repair-observe ${JSON.stringify({ mode: 'observe', repository, spec: f.spec.number, ticket: target.number,
    deferCandidate: scenario === 'progressive-five',
    ...(upstream ? { upstream: upstream.number, barrierUrl: fixed.barrierUrl } : {}) })}` })).success, true);
  if (real) assert.equal((await pi.request('prompt', { message: `/fixture-repair-model ${JSON.stringify({ repository, provider: fixed.provider })}` })).success, true);
  const wrapped = { ...f, ticket: target, contract, fixed, pi, reportCache: new Map(), get approved() { return approved; },
    async run() {
      const output = await pi.flow(`start ${f.spec.number} --concurrency 2`, true); fixed.assertHealthy();
      await pi.request('prompt', { message: '/fixture-repair-observe-status' });
      const observer = JSON.parse(pi.notices.findLast(item => item.startsWith('REPAIR_OBSERVER: ')).slice('REPAIR_OBSERVER: '.length));
      assert.deepEqual(observer.barrierErrors, []);
      if (conflict) {
        assert.equal(fixed.barrier.targetObserved, true); assert.equal(fixed.barrier.upstreamSubmission?.ticket, upstream.number);
        assert.equal(observer.started.length, 2);
        for (const started of observer.started) assert.equal(started.startedFrom, f.baseline);
      }
      const ticketPulls = f.pulls().filter(pr => pr.head.ref === `flow/ticket-${f.spec.number}-${target.number}`);
      assert.equal(ticketPulls.length, 1, 'target Ticket owns exactly one remote PR');
      const failures = [...output.matchAll(/GATE_FAILED: candidate ([a-f0-9]{40}) (behavior|review|text-conflict) (https:\/\/github\.com\/\S+) ([a-f0-9]{64})/g)]
        .map(match => ({ sha: match[1], kind: match[2], url: match[3], sha256: match[4] }));
      const gates = observer.gates.filter(item => {
        const report = download(wrapped, item); return report.ticket === target.number;
      });
      const repairs = [...output.matchAll(new RegExp(`TICKET_REPAIRED: #${target.number} ([a-f0-9]{40}) ([a-f0-9]{40}) (https://github\\.com/\\S+)`, 'g'))]
        .map(match => ({ before: match[1], after: match[2], url: match[3] }));
      const reports = [...failures, ...gates].map(item => download(wrapped, item));
      const latest = reports.findLast(report => report.implementationEvidence.head === ticketPulls[0].head.sha);
      assert.ok(latest, 'the final remote head is retained in actual gate/failure evidence');
      const delivered = new RegExp(`TICKET_DELIVERED: #${target.number} ([a-f0-9]{40})`).exec(output);
      const blocked = new RegExp(`TICKET_BLOCKED: Ticket #${target.number} (https://github\\.com/\\S+)`).exec(output);
      const status = delivered ? 'delivered' : output.includes(`TICKET_NO_PROGRESS: #${target.number} `) ? 'no-progress' : blocked ? 'blocked' : 'failed';
      let repairModel;
      if (real) {
        await pi.request('prompt', { message: '/fixture-repair-model-status' });
        const models = JSON.parse(pi.notices.findLast(item => item.startsWith('REPAIR_MODEL_OBSERVER: ')).slice('REPAIR_MODEL_OBSERVER: '.length));
        const repairs = models.filter(item => item.role === 'implementation' && item.repair);
        assert.ok(repairs.length > 0); assert.ok(repairs.every(item => item.provider === 'openai' && item.id === 'gpt-6-astra'));
        assert.ok(models.filter(item => item.role === 'review').every(item => item.provider === 'openai' && item.id === 'gpt-6-astra'));
        repairModel = { provider: 'openai', id: 'gpt-6-astra' };
      }
      const question = blocked ? api(`repos/${repository}/issues/${target.number}/comments?per_page=100`).find(item => item.html_url === blocked[1]) : undefined;
      return { status, failures, gates, repairs, proof: latest.implementationEvidence, M: delivered?.[1], ticketPulls,
        repairModel, repairPrompts: [...output.matchAll(new RegExp(`REPAIR_STARTED: Ticket #${target.number} `, 'g'))].length,
        mergeRequests: observer.mergeRequests, closeRequests: observer.closeRequests,
        candidateWaits: observer.candidateWaits, deferredReads: observer.deferredReads,
        question: question ? { url: question.html_url, body: question.body } : undefined };
    },
    verifyInvariants(state) {
      f.verifyInvariants(upstream ? 'closed' : state);
      assert.equal(api(`repos/${repository}/issues/${target.number}`).state, state);
      const totals = api(`repos/${repository}/pulls?state=all&head=${encodeURIComponent(`nanzhi84:${f.feature}`)}&base=main`);
      if (state === 'closed') assert.equal(totals.length, 1);
      for (const total of totals) { assert.equal(total.draft, true); assert.equal(total.state, 'open'); }
    },
    verifyRemoteBehavior(sha) {
      git(f.project, 'fetch', '--quiet', 'origin', sha);
      const cwd = join(f.project, '..', 'verify-remote-repair'); git(f.project, 'worktree', 'add', '--quiet', '--detach', cwd, sha);
      assert.deepEqual(runGreeting(cwd, 'Ada'), { exitCode: 0, stdout: 'Hello, Ada!\n' });
      assert.deepEqual(runGreeting(cwd, ' Ada '), { exitCode: 0, stdout: 'Hello,  Ada !\n' });
      for (const name of [...whitespaceCases.map(item => item[1]), '\v', ' \t\f\v\u00a0\u2003', 'Ada\nLovelace', 'Ada\rLovelace']) assert.deepEqual(runGreeting(cwd, name), { exitCode: 2, stdout: '' });
      assert.deepEqual(runGreeting(cwd, '\u00a0Ada\u2003'), { exitCode: 0, stdout: 'Hello, \u00a0Ada\u2003!\n' });
      assert.deepEqual(runGreeting(cwd), { exitCode: 2, stdout: '' });
      if (conflict) assert.deepEqual(runGreeting(cwd, 'Reserved'), { exitCode: 2, stdout: '' });
      if (scenario === 'review-progress') {
        let rejected;
        try { execFileSync(process.execPath, ['app.mjs', ' '], { cwd, stdio: 'pipe' }); } catch (error) { rejected = error; }
        assert.equal(rejected?.status, 2);
        assert.match(rejected.stderr.toString('utf8'), /blank name/);
        assert.match(rejected.stderr.toString('utf8'), /Usage: app\.mjs NAME/);
      }
    },
    pass(result, assertions) {
      f.pass({ assertions, status: result.status, boundary: real ? 'controlled initial SDK transport; real OpenAI repair and independent review' : 'deterministic model HTTP; actual SDK writes/CLI/GitHub',
        failures: result.failures, gates: result.gates, appendedCommits: result.repairs, M: result.M,
        candidateWaits: result.candidateWaits, deferredReads: result.deferredReads,
        ticketPr: result.ticketPulls[0].html_url, repairPrompts: result.repairPrompts, proofSegments: result.proof.segments.length });
    },
  };
  return wrapped;
}
