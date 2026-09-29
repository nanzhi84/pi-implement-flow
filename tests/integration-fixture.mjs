import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, fixture, git, repository, runGreeting } from './execution-fixture.mjs';
import { implementationFiles, integrationProvider } from './integration-provider.mjs';
export { api, git, repository };
export const names = ['real-integration', 'accept-failure', 'review-rejects-self-approval', 'evidence-unavailable',
  'stale-head', 'stale-base', 'actual-merge-recheck-fails', 'base-race-after-final-read'];

const requirement = `First add a real CLI acceptance assertion named whitespace-only-rejected to fixture.mjs; preserve every existing acceptance assertion and executable check. Then change app.mjs to reject entirely whitespace names (spaces or tabs) with exit code 2 and empty stdout. Preserve Ada greeting, meaningful whitespace, missing-name rejection and newline rejection. Only app.mjs and fixture.mjs may change. This Ticket requires additive acceptance coverage under the project rule permitting new behavior assertions before implementation; preserve every existing assertion and executable check. Do not change .pi/flow.json, commands, AGENTS.md or publish.mjs. Internal gates may merge the Ticket PR into its feature branch and close the Ticket only after actual-version evidence is complete. Keep the Spec open and total PR Draft; never merge main.`;

export async function integrationFixture(t, scenario) {
  const identity = api(`repos/${repository}`).id;
  assert.ok(Number.isSafeInteger(identity) && identity > 0);
  const lockKey = createHash('sha256').update(`github.com:${identity}`).digest('hex').slice(0, 24);
  const socket = `/tmp/pi-flow-${process.getuid()}-${lockKey}.sock`;
  await assert.rejects(access(socket), { code: 'ENOENT' }, 'never take over an existing controller or stale socket');
  const fixed = scenario === 'real-integration' ? undefined : await integrationProvider(t, scenario);
  const f = await fixture(t, scenario, {
    stage: 'T3', fixed, preserveOnPass: scenario !== 'real-integration',
    specBody: `## Problem Statement\n\nImplement whitespace-only name rejection in the synthetic greeting CLI. ${requirement}\n\n## Acceptance criteria\n\n- Add the named CLI assertion before implementation, preserving existing checks.\n- Deliver one independently reviewed Ticket PR through candidate and actual-version gates.\n- After verified integration close the Ticket, keep Spec open and total PR Draft, and preserve main.`,
    ticketBody: spec => `## What to build\n\n${requirement}\n\nPart of #${spec}.\n\n## Acceptance criteria\n\n- Whitespace-only names exit 2 with no stdout.\n- Ada and meaningful surrounding whitespace preserve their exact existing greeting.\n- Missing/newline names remain rejected.\n- The candidate and actual merge acceptance reports include greeting-for-name, missing-name-rejected and whitespace-only-rejected.\n\n## Blocked by\n\nNone`,
  });
  // Registered after fixture teardown: its pi process must have exited first.
  // Only a socket absent before this isolated scenario may be reconciled here.
  t.after(async () => {
    let before;
    try { before = await lstat(socket); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    assert.equal(before.isSocket(), true, 'never remove an unexpected non-socket resource');
    let noOwner = false;
    try { execFileSync('lsof', ['-t', socket], { stdio: 'pipe' }); }
    catch (error) { noOwner = error.status === 1; }
    assert.equal(noOwner, true, 'never remove a socket with a live owner or unknown ownership');
    const after = await lstat(socket);
    assert.equal(after.ino, before.ino, 'never remove a replaced controller socket');
    await rm(socket); // Test-owned stale control only; Git/worktrees/remote facts stay intact.
  });
  fixed?.setImplementation(await implementationFiles(f.project, scenario === 'review-rejects-self-approval'));
  const contract = JSON.parse(await readFile(join(f.project, '.pi/flow.json'), 'utf8'));
  const mode = ['real-integration', 'review-rejects-self-approval'].includes(scenario) ? 'observe' : scenario;
  let confirmation;
  const pi = await f.open({ onConfirm: event => { confirmation = event.message; return true; }, extensions: [fileURLToPath(new URL('./fixtures/integration-bridge.mjs', import.meta.url))] });
  assert.equal((await pi.request('prompt', { message: `/fixture-integration ${JSON.stringify({ mode, repository, spec: f.spec.number, ticket: f.ticket.number })}` })).success, true);
  return { ...f, pi, fixed, contract, get confirmation() { return confirmation; },
    async run() {
      const output = await pi.flow(`start ${f.spec.number}`, true);
      fixed?.assertHealthy();
      return output;
    },
    async observer() {
      const boundary = pi.notices.length;
      assert.equal((await pi.request('prompt', { message: '/fixture-integration-status' })).success, true);
      const notice = pi.notices.slice(boundary).find(item => item.startsWith('INTEGRATION_OBSERVER: '));
      assert.ok(notice, 'test observer must expose verified UI/CLI boundary observations');
      return JSON.parse(notice.slice('INTEGRATION_OBSERVER: '.length));
    },
  };
}
export function featureSha(f) { return api(`repos/${repository}/git/ref/heads/${f.feature}`).object.sha; }
export function ticketPull(f) {
  const pulls = f.pulls();
  assert.equal(pulls.length, 1);
  return api(`repos/${repository}/pulls/${pulls[0].number}`);
}
export function totals(f) { return api(`repos/${repository}/pulls?state=all&head=${encodeURIComponent(`nanzhi84:${f.feature}`)}&base=main`); }
export function commit(sha) { return api(`repos/${repository}/git/commits/${sha}`); }
export function assertNoDelivery(f, output, expectedFeature = f.baseline) {
  const pr = ticketPull(f);
  assert.equal(pr.merged, false);
  assert.equal(pr.state, 'open');
  assert.equal(featureSha(f), expectedFeature);
  assert.doesNotMatch(output, /TICKET_DELIVERED:/);
  for (const total of totals(f)) assert.equal(total.draft, true);
  f.verifyInvariants();
  return pr;
}
export function readGate(f, observation) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(observation.url);
  assert.ok(match); assert.equal(match[1], repository);
  const bytes = execFileSync('gh', ['release', 'download', match[2], '--repo', repository, '--pattern', match[3], '--output', '-'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  const report = JSON.parse(bytes.toString('utf8'));
  assert.equal(report.schema, 3);
  assert.equal(report.generator, 'pi-implement-flow/ticket-gate-v1');
  assert.equal(report.kind, 'ticket-gate');
  assert.equal(report.phase, observation.phase);
  assert.equal(report.codeSha, observation.sha);
  assert.equal(report.repository, repository);
  assert.equal(report.spec, f.spec.number); assert.equal(report.ticket, f.ticket.number);
  for (const key of ['scopeDigest', 'contractDigest', 'instructionsDigest', 'sourceDiffDigest']) assert.match(report[key], /^[a-f0-9]{64}$/);
  assert.equal(report.contractDigest, createHash('sha256').update(JSON.stringify(f.contract)).digest('hex'));
  assert.equal(report.commandSource, '.pi/flow.json');
  assert.deepEqual(report.commands, ['prepare', 'check', 'accept', 'cleanup']);
  assert.deepEqual(report.commandDefinitions, Object.fromEntries(['prepare', 'check', 'accept', 'cleanup'].map(phase => [phase, f.contract.commands[phase]])));
  assert.equal(report.commandTimeoutMs, f.contract.commandTimeoutMs);
  assert.equal(report.reviewSource.isolation, 'independent-context');
  assert.deepEqual(report.reviewSource.tools, f.contract.agents.review.tools);
  assert.deepEqual(report.reviewSource.model, f.fixed?.model ?? { provider: process.env.PI_PROVIDER, id: process.env.PI_MODEL });
  assert.equal(report.prerequisites.resourcesMode, f.contract.resources.mode);
  assert.equal(report.prerequisites.resourcesDescription, f.contract.resources.description);
  assert.ok(report.prerequisites.node);
  assert.equal(report.acceptance.passed, true);
  const assertions = report.acceptance.assertions;
  assert.ok(assertions.every(item => item.passed === true));
  for (const name of ['greeting-for-name', 'missing-name-rejected', 'whitespace-only-rejected']) assert.ok(assertions.some(item => item.name === name), name);
  assert.equal(report.cleanup, 'passed');
  assert.ok(report.retentionDays >= f.contract.artifacts.retentionDays);
  assert.equal(report.review.kind, 'review');
  assert.equal(report.review.codeSha, report.codeSha);
  assert.equal(report.review.scopeDigest, report.scopeDigest);
  assert.deepEqual(report.review.blockers, []);
  assert.ok(Array.isArray(report.review.suggestions));
  return { report, url: observation.url, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export function verifyVersionChain(f, pr, gate) {
  const { H, B, C } = gate.report.versions;
  assert.equal(H, pr.head.sha);
  assert.equal(B, f.baseline);
  assert.equal(C, gate.report.codeSha);
  const candidate = commit(C);
  assert.deepEqual(candidate.parents.map(parent => parent.sha), [B, H]);
  const merged = commit(pr.merge_commit_sha);
  assert.deepEqual(merged.parents.map(parent => parent.sha), [B, H]);
  assert.equal(merged.tree.sha, candidate.tree.sha);
  assert.equal(featureSha(f), merged.sha);
  return { H, B, C, M: merged.sha };
}
export function verifyRemoteBehavior(f, sha) {
  git(f.project, 'fetch', '--quiet', 'origin', sha);
  assert.equal(git(f.project, 'rev-parse', 'FETCH_HEAD'), sha);
  const cwd = join(f.project, '..', 'verify-remote-integration');
  git(f.project, 'worktree', 'add', '--quiet', '--detach', cwd, sha);
  assert.deepEqual(runGreeting(cwd, 'Ada'), { exitCode: 0, stdout: 'Hello, Ada!\n' });
  assert.deepEqual(runGreeting(cwd, ' Ada '), { exitCode: 0, stdout: 'Hello,  Ada !\n' });
  for (const name of ['   ', '\t', '\t \t', 'Ada\nLovelace']) assert.deepEqual(runGreeting(cwd, name), { exitCode: 2, stdout: '' });
  assert.deepEqual(runGreeting(cwd), { exitCode: 2, stdout: '' });
  assert.deepEqual(git(cwd, 'diff', '--name-only', f.baseline, sha).split('\n'), ['app.mjs', 'fixture.mjs']);
}
