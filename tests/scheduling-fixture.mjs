import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, fixture, git, repository, created, persist } from './execution-fixture.mjs';
import { names, baselines, requests, fixedFiles } from './scheduling-cases.mjs';
import { schedulingHarness } from './scheduling-harness.mjs';
import { schedulingProvider } from './scheduling-provider.mjs';
export { names };
const hash = value => createHash('sha256').update(value).digest('hex');
const remoteCommit = sha => api(`repos/${repository}/git/commits/${sha}`);
const issueBody = (request, spec, dependencies) => `## What to build\n\n${request}\n\nPart of #${spec}.\n\n## Acceptance criteria\n\n- Complete the explicit observable behavior and preserve all unrelated existing checks.\n- Each implementation has independent candidate and actual-version gates before verified closure.\n- Main remains unchanged; parent remains open; total PR remains Draft.\n\n## Blocked by\n\n${dependencies.length ? dependencies.map(issue => `- #${issue.number}`).join('\n') : 'None'}`;
export async function graphFixture(t, scenario) {
  const expectedRepository = scenario === names[2] ? 'nanzhi84/pi-implement-flow-exclusive-acceptance' : 'nanzhi84/pi-implement-flow-scheduling-acceptance';
  assert.equal(repository, expectedRepository, 'select the scenario-owned repository before any write');
  const identity = api(`repos/${repository}`).id;
  assert.equal(identity, scenario === names[2] ? 1396650590 : 1396650555);
  assert.equal(api(`repos/${repository}/branches/main`).commit.sha, baselines[repository]);
  const socket = `/tmp/pi-flow-${process.getuid()}-${hash(`github.com:${identity}`).slice(0, 24)}.sock`;
  await assert.rejects(access(socket), { code: 'ENOENT' });
  const harness = await schedulingHarness(scenario);
  const fixed = scenario === names[0] ? undefined : await schedulingProvider(t, scenario, harness);
  const requirement = requests(scenario);
  const f = await fixture(t, scenario, { stage: 'T4', fixed, preserveOnPass: true,
    specBody: `## Problem Statement\n\nIsolated scheduling acceptance. All following approved Ticket requirements apply; preserve main, project commands and authorization boundaries.\n\n${Object.entries(requirement).map(([key, value]) => `Ticket ${key}: ${value}`).join('\n\n')}\n\n## Acceptance criteria\n\n- Independent Tickets can implement in parallel within concurrency 2.\n- Explicit downstream Tickets only begin after all dependencies have verified actual integration delivery.\n- Every candidate uses the latest accepted feature baseline; no textual-conflict shortcut.\n- Preserve original Ada/missing behavior, main and open parent; total remains Draft.\n- An unresolved local Ticket blocks its downstream only; composed semantic failure must not merge.`,
    ticketBody: spec => issueBody(requirement.A, spec, []),
  });
  assert.equal(f.baseline, baselines[repository]);
  const tickets = { A: f.ticket };
  for (const key of Object.keys(requirement).filter(key => key !== 'A')) {
    const dependencies = key === 'C' ? [tickets.A, tickets.B] : key === 'E' ? [tickets.D] : [];
    const ticket = api(`repos/${repository}/issues`, { title: `[Synthetic] T4 ${scenario} ${key}`, body: issueBody(requirement[key], f.spec.number, dependencies) });
    tickets[key] = ticket; created.push({ scenario, kind: 'ticket', number: ticket.number, url: ticket.html_url }); await persist();
    api(`repos/${repository}/issues/${f.spec.number}/sub_issues`, { sub_issue_id: ticket.id });
    for (const dependency of dependencies) api(`repos/${repository}/issues/${ticket.number}/dependencies/blocked_by`, { issue_id: dependency.id });
  }
  harness.setup(tickets); fixed?.setup(tickets, await fixedFiles(f.project, scenario));
  const contract = JSON.parse(await readFile(join(f.project, '.pi/flow.json'), 'utf8'));
  assert.equal(contract.resources.mode, scenario === names[2] ? 'exclusive' : 'isolated');
  let confirmation;
  const pi = await f.open({ timeoutMs: 2_600_000, onConfirm: event => { confirmation = event.message; return true; },
    extensions: [fileURLToPath(new URL('./fixtures/scheduling-bridge.mjs', import.meta.url))] });
  const configured = await pi.request('prompt', { message: `/fixture-scheduling ${JSON.stringify({ repository, scenario, url: harness.url, tickets: Object.values(tickets).map(item => item.number) })}` });
  assert.equal(configured.success, true);
  // pi teardown is registered by fixture before this hook. Preserve remote/Git
  // facts; remove only this scenario's now-unowned socket, never another owner.
  t.after(async () => {
    await harness.close();
    let before; try { before = await lstat(socket); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    assert.equal(before.isSocket(), true);
    let noOwner = false; try { execFileSync('lsof', ['-t', socket], { stdio: 'pipe' }); } catch (error) { noOwner = error.status === 1; }
    assert.equal(noOwner, true); assert.equal((await lstat(socket)).ino, before.ino); await rm(socket);
  });
  let observation;
  const verifiedGates = new Map();
  const apiResult = { ...f, tickets, scenario, contract, fixed,
    get confirmation() { return confirmation; },
    async run() { const output = await pi.flow(`start ${f.spec.number} --concurrency 2`, true); fixed?.assertHealthy(); return output; },
    async observe() {
      assert.equal((await pi.request('prompt', { message: '/fixture-scheduling-flush' })).success, true);
      const raw = harness.snapshot();
      const parse = prefix => raw.events.filter(item => item.type === 'notice' && item.message.startsWith(prefix)).map(item => ({ ...JSON.parse(item.message.slice(prefix.length)), sequence: item.sequence }));
      const activities = parse('FLOW_ACTIVITY: '); const states = parse('FLOW_TICKET_STATE: ');
      const starts = parse('TICKET_STARTED: ').map(item => ({ ...item, sha: item.startedFrom }));
      const deliveries = raw.events.filter(item => item.type === 'notice' && item.message.startsWith('TICKET_DELIVERED: ')).map(item => {
        const match = /^TICKET_DELIVERED: #(\d+) ([a-f0-9]{40}) /.exec(item.message); assert.ok(match); return { ticket: Number(match[1]), M: match[2], sequence: item.sequence };
      });
      const gates = raw.events.filter(item => item.type === 'notice' && item.message.startsWith('GATE_PASSED: ')).map(item => {
        const match = /^GATE_PASSED: (candidate|actual) ([a-f0-9]{40}) (https:\/\/\S+)$/.exec(item.message); assert.ok(match); return { phase: match[1], sha: match[2], url: match[3], sequence: item.sequence };
      });
      const commands = raw.events.filter(item => item.type === 'command' && item.event === 'end');
      const candidates = commands.filter(item => item.phase === 'candidate' && item.command === 'prepare').map(item => {
        const commit = remoteCommit(item.sha); return { ticket: item.ticket, C: item.sha, B: commit.parents[0].sha, H: commit.parents[1].sha };
      });
      const prs = f.pulls();
      const merges = raw.events.filter(item => item.type === 'merge').map(item => ({ ...item, ticket: Number(prs.find(pr => pr.number === item.pr)?.head.ref.split('-').at(-1)) }));
      const firstReview = activities.find(item => item.kind === 'review' && item.event === 'start')?.sequence ?? Infinity;
      observation = { ...raw, activities, starts, deliveries, gates, commands, candidates, merges,
        submittedBeforeFirstReview: states.filter(item => item.state === 'submitted' && item.sequence < firstReview).length };
      return observation;
    },
    verifiedGates,
    get observation() { assert.ok(observation); return observation; },
    branchHead() { return api(`repos/${repository}/git/ref/heads/${f.feature}`).object.sha; },
    nativeDependencies(key) { return api(`repos/${repository}/issues/${tickets[key].number}/dependencies/blocked_by`).map(item => item.number); },
    isAncestor(ancestor, descendant) { git(f.project, 'fetch', '--quiet', 'origin', descendant); return git(f.project, 'merge-base', ancestor, descendant) === ancestor; },
    changedPaths(head) { return git(f.project, 'diff', '--name-only', f.baseline, head).split('\n'); },
    async checkout(sha) { git(f.project, 'fetch', '--quiet', 'origin', sha); const dir = await mkdtemp(join(f.project, '..', 'verify-')); git(f.project, 'worktree', 'add', '--quiet', '--detach', dir, sha); return dir; },
    async verifyRemote(sha, file, args, stdout) {
      const cwd = await apiResult.checkout(sha); const value = spawnSync(process.execPath, [file, ...args], { cwd, encoding: 'utf8', timeout: 10_000 });
      assert.equal(value.error, undefined); assert.equal(value.status, 0); assert.equal(value.stdout, stdout);
    },
    async verifyOldBaseBehavior(sha) {
      const cwd = await apiResult.checkout(sha); const resources = await mkdtemp(join(f.project, '..', 'verify-data-'));
      for (const phase of ['prepare', 'check', 'accept', 'cleanup']) {
        const output = execFileSync(process.execPath, ['fixture.mjs', phase], { cwd, encoding: 'utf8', env: { ...process.env, FLOW_RESOURCE_DIR: resources }, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
        if (phase === 'accept') { const value = JSON.parse(output); assert.equal(value.passed, true); assert.ok(value.assertions.some(item => item.name === 'semantic-original' && item.passed)); }
      }
      return true;
    },
    async verifyEnd() {
      f.verifyInvariants(api(`repos/${repository}/issues/${f.ticket.number}`).state);
      const total = api(`repos/${repository}/pulls?state=all&head=${encodeURIComponent(`nanzhi84:${f.feature}`)}&base=main`);
      assert.equal(total.length, 1); assert.equal(total[0].draft, true); assert.equal(total[0].state, 'open'); assert.equal(total[0].head.sha, apiResult.branchHead());
      for (const ticket of Object.values(tickets)) {
        const delivered = observation.deliveries.some(item => item.ticket === ticket.number);
        const issue = api(`repos/${repository}/issues/${ticket.number}`);
        assert.equal(issue.state, delivered ? 'closed' : 'open'); if (delivered) assert.equal(issue.state_reason, 'completed');
      }
      const order = observation.merges;
      let latest = f.baseline;
      for (const merge of order) { const pr = api(`repos/${repository}/pulls/${merge.pr}`); assert.equal(pr.merged, true); const commit = remoteCommit(pr.merge_commit_sha); assert.equal(commit.parents[0].sha, latest); latest = pr.merge_commit_sha; }
      assert.equal(apiResult.branchHead(), latest);
      if (scenario === names[2]) { await apiResult.verifyRemote(latest, 'alpha.mjs', [], 'alpha\n'); await apiResult.verifyRemote(latest, 'beta.mjs', [], 'beta\n'); }
    },
  };
  return apiResult;
}
export function verifyActivities(observed, capacity) {
  const active = new Map(); let peak = 0;
  for (const item of observed.activities) {
    const key = `${item.ticket}/${item.phase}/${item.kind}/${item.codeSha}`;
    if (item.event === 'start') { assert.ok(!active.has(key)); active.set(key, item); peak = Math.max(peak, active.size); assert.ok(active.size <= capacity); }
    else { assert.ok(active.has(key)); assert.equal(item.event, 'end', 'no hidden retained activity in successful scheduling assertions'); active.delete(key); }
  }
  assert.equal(active.size, 0); assert.ok(peak > 0);
  for (const command of observed.commands) {
    const start = observed.activities.find(item => item.ticket === command.ticket && item.phase === command.phase && item.kind === command.command && item.event === 'start');
    const end = observed.activities.find(item => item.ticket === command.ticket && item.phase === command.phase && item.kind === command.command && item.event === 'end');
    assert.ok(start && end && start.sequence < command.sequence && end.sequence > command.sequence, 'actual child exit is covered by its activity permit');
  }
}
async function readGate(f, gate) {
  if (f.verifiedGates.has(gate.url)) return f.verifiedGates.get(gate.url);
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(gate.url);
  assert.ok(match); assert.equal(match[1], repository);
  const bytes = execFileSync('gh', ['release', 'download', match[2], '--repo', repository, '--pattern', match[3], '--output', '-'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  const report = JSON.parse(bytes);
  assert.equal(report.codeSha, gate.sha); assert.equal(report.phase, gate.phase); assert.equal(report.repository, repository); assert.equal(report.spec, f.spec.number);
  const approved = JSON.parse(f.confirmation.slice(f.confirmation.indexOf('\n{') + 1));
  assert.equal(report.scopeDigest, hash(JSON.stringify(approved))); assert.equal(report.contractDigest, hash(JSON.stringify(f.contract)));
  assert.equal(report.review.codeSha, report.codeSha); assert.equal(report.review.scopeDigest, report.scopeDigest); assert.deepEqual(report.review.blockers, []);
  assert.deepEqual(report.reviewSource.model, f.fixed?.model ?? { provider: 'openai', id: 'gpt-6-astra' });
  assert.equal(report.reviewSource.isolation, 'independent-context'); assert.equal(report.cleanup, 'passed');
  assert.equal(report.acceptance.passed, true); assert.ok(report.acceptance.assertions.every(item => item.passed));
  for (const name of ['greeting-for-name', 'missing-name-rejected']) assert.ok(report.acceptance.assertions.some(item => item.name === name));
  const original = approved.plan.tickets.find(item => item.issue.number === report.ticket); assert.ok(original);
  assert.equal(report.approvedContext.ticket.body.text, original.issue.body); assert.equal(report.approvedContext.ticket.body.sha256, hash(original.issue.body));
  assert.deepEqual(report.approvedContext.ticket.dependencies, original.dependencies);
  const verified = { report, url: gate.url, sha256: hash(bytes) }; f.verifiedGates.set(gate.url, verified); return verified;
}
export async function verifyDelivery(f, key) {
  const ticket = f.tickets[key].number; const pulls = f.pulls().filter(pr => pr.head.ref === `flow/ticket-${f.spec.number}-${ticket}`); assert.equal(pulls.length, 1);
  const pr = api(`repos/${repository}/pulls/${pulls[0].number}`); assert.equal(pr.merged, true); assert.equal(pr.state, 'closed');
  const gates = await Promise.all(f.observation.gates.map(item => readGate(f, item))); const candidate = gates.find(item => item.report.ticket === ticket && item.report.phase === 'candidate');
  assert.ok(candidate); const { H, B, C } = candidate.report.versions; const M = pr.merge_commit_sha;
  assert.equal(H, pr.head.sha); assert.deepEqual(remoteCommit(C).parents.map(item => item.sha), [B, H]);
  assert.deepEqual(remoteCommit(M).parents.map(item => item.sha), [B, H]); assert.equal(remoteCommit(M).tree.sha, remoteCommit(C).tree.sha);
  const actual = M === C ? candidate : gates.find(item => item.report.ticket === ticket && item.report.codeSha === M && item.report.phase === 'actual'); assert.ok(actual);
  assert.deepEqual(actual.report.approvedContext, candidate.report.approvedContext);
  if (f.scenario === names[0]) for (const name of key === 'C' ? ['upper-cli', 'repeat-cli', 'combined-cli'] : [`${key === 'A' ? 'upper' : 'repeat'}-cli`]) assert.ok(actual.report.acceptance.assertions.some(item => item.name === name && item.passed));
  const delivered = f.observation.deliveries.find(item => item.ticket === ticket); assert.equal(delivered?.M, M);
  const closes = f.observation.events.filter(item => item.type === 'close' && item.ticket === ticket); assert.equal(closes.length, 1);
  const actualNotice = f.observation.gates.find(item => item.sha === M) ?? f.observation.gates.find(item => item.sha === C);
  assert.ok(closes[0].sequence > actualNotice.sequence && closes[0].sequence < delivered.sequence);
  const issue = api(`repos/${repository}/issues/${ticket}`); assert.equal(issue.state, 'closed'); assert.equal(issue.state_reason, 'completed');
  const comments = api(`repos/${repository}/issues/${ticket}/comments`); assert.ok(comments.some(item => item.body.includes(M) && item.body.includes(candidate.url) && item.body.includes(actual.url)));
  return { ticket, pr: pr.html_url, H, B, C, M, scopeDigest: candidate.report.scopeDigest, evidence: [{ url: candidate.url, sha256: candidate.sha256 }, { url: actual.url, sha256: actual.sha256 }] };
}
export async function verifyNoDelivery(f, key) {
  const number = f.tickets[key].number; assert.equal(api(`repos/${repository}/issues/${number}`).state, 'open');
  assert.ok(!f.observation.deliveries.some(item => item.ticket === number)); assert.ok(!f.observation.events.some(item => item.type === 'close' && item.ticket === number));
  const pulls = f.pulls().filter(pr => pr.head.ref === `flow/ticket-${f.spec.number}-${number}`); assert.ok(pulls.length <= 1);
  if (!pulls.length) return undefined;
  const pr = api(`repos/${repository}/pulls/${pulls[0].number}`); assert.equal(pr.merged, false); assert.equal(pr.state, 'open'); return pr;
}
