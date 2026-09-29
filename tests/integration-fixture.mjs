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
  'stale-head', 'stale-base', 'actual-merge-recheck-fails', 'actual-review-blockers-recorded', 'base-race-after-final-read', 'review-response-too-large'];

const privacyMarkers = ['FLOW_SYNTHETIC_CONTEXT_KEY_NOT_A_CREDENTIAL', 'FLOW_SYNTHETIC_BEARER_NOT_A_CREDENTIAL',
  'FLOW_SYNTHETIC_URL_PASSWORD', 'FLOW_SYNTHETIC_PRIVATE_PATH'];
const publicReference = 'https://github.com/nanzhi84/pi-implement-flow/pull/20#discussion_r4138507096';
const privacyNote = `\n\n## Evidence privacy fixture\n\nThese non-functional, synthetic examples only exercise artifact redaction; they are not real credentials, resources or implementation requirements. Do not copy their values into implementation or review findings.\nAPI_KEY=${privacyMarkers[0]}\nSynthetic header: Bearer ${privacyMarkers[1]}\nSynthetic URL: https://fixture-user:${privacyMarkers[2]}@example.invalid/demo?token=synthetic\nSynthetic local path: /Users/${privacyMarkers[3]}/private-config\n[Public evidence reference](${publicReference})\n`;

const requirement = `First add a real CLI acceptance assertion named whitespace-only-rejected to fixture.mjs; preserve every existing acceptance assertion and executable check. Apply this single rule: reject with exit code 2 and empty stdout if the name is missing, contains CR or LF, or name.trim() === ''; otherwise emit the existing greeting with the accepted name's exact original contents. The emptiness check uses JavaScript String.trim whitespace semantics; cover spaces, TAB, form feed, vertical tab, NBSP (U+00A0) and U+2003. Use trim only for emptiness detection, never to normalize an accepted name or its greeting. Preserve the exact Ada greeting and meaningful surrounding whitespace in accepted names. Only app.mjs and fixture.mjs may change. This Ticket requires additive acceptance coverage under the project rule permitting new behavior assertions before implementation; preserve every existing assertion and executable check. Do not change .pi/flow.json, commands, AGENTS.md or publish.mjs. Internal gates may merge the Ticket PR into its feature branch and close the Ticket only after actual-version evidence is complete. Keep the Spec open and total PR Draft; never merge main.`;

export async function integrationFixture(t, scenario) {
  const identity = api(`repos/${repository}`).id;
  assert.ok(Number.isSafeInteger(identity) && identity > 0);
  const lockKey = createHash('sha256').update(`github.com:${identity}`).digest('hex').slice(0, 24);
  const socket = `/tmp/pi-flow-${process.getuid()}-${lockKey}.sock`;
  await assert.rejects(access(socket), { code: 'ENOENT' }, 'never take over an existing controller or stale socket');
  const fixed = scenario === 'real-integration' ? undefined : await integrationProvider(t, scenario);
  const privacy = scenario === 'actual-review-blockers-recorded';
  const f = await fixture(t, scenario, {
    stage: 'T3', fixed, preserveOnPass: scenario !== 'real-integration',
    specBody: `## Problem Statement\n\nImplement JavaScript String.trim blank-name rejection in the synthetic greeting CLI. ${requirement}\n\n## Acceptance criteria\n\n- Add the named CLI assertion before implementation, covering spaces, TAB, form feed, vertical tab, NBSP (U+00A0) and U+2003 while preserving existing checks.\n- Reject a missing name, a name containing CR or LF, or a name with name.trim() === ''; otherwise preserve the accepted name's exact original contents in the greeting.\n- Deliver one independently reviewed Ticket PR through candidate and actual-version gates.\n- After verified integration close the Ticket, keep Spec open and total PR Draft, and preserve main.${privacy ? privacyNote : ''}`,
    ticketBody: spec => `## What to build\n\n${requirement}\n\nPart of #${spec}.\n\n## Acceptance criteria\n\n- Reject with exit code 2 and no stdout if the name is missing, contains CR or LF, or name.trim() === ''; otherwise accept it.\n- The blank-name check uses JavaScript String.trim semantics; cover spaces, TAB, form feed, vertical tab, NBSP (U+00A0) and U+2003.\n- Ada and all accepted names, including meaningful surrounding whitespace, preserve their exact original contents in the greeting; use trim only for emptiness detection, never output normalization.\n- The candidate and actual merge acceptance reports include greeting-for-name, missing-name-rejected and whitespace-only-rejected.\n\n## Blocked by\n\nNone`,
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
  const mode = ['real-integration', 'review-rejects-self-approval', 'actual-review-blockers-recorded', 'review-response-too-large'].includes(scenario) ? 'observe' : scenario;
  let confirmation;
  const pi = await f.open({ onConfirm: event => { confirmation = event.message; return true; }, extensions: [fileURLToPath(new URL('./fixtures/integration-bridge.mjs', import.meta.url))] });
  assert.equal((await pi.request('prompt', { message: `/fixture-integration ${JSON.stringify({ mode, repository, spec: f.spec.number, ticket: f.ticket.number })}` })).success, true);
  return { ...f, pi, fixed, contract, privacy, get confirmation() { return confirmation; },
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
function verifyImplementationEvidence(f, report) {
  const proof = report.implementationEvidence;
  assert.equal(proof.source, 'controller-worktree-writes');
  assert.equal(proof.baseline, f.baseline);
  assert.equal(proof.head, report.versions.H);
  assert.equal(proof.scopeDigest, report.scopeDigest);
  for (const sha of [proof.baseline, proof.head, report.codeSha]) assert.match(sha, /^[a-f0-9]{40}$/);
  // The shared git() helper trims text; raw bytes are required to retain final newlines.
  const raw = (...args) => execFileSync('git', args, { cwd: f.project,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  raw('fetch', '--quiet', 'origin', ...new Set([proof.baseline, proof.head, report.codeSha]));
  const trees = new Map(); const digests = new Map();
  const digest = (sha, path) => {
    if (!trees.has(sha)) trees.set(sha, new Set(raw('ls-tree', '-r', '--name-only', '-z', sha).toString('utf8').split('\0').filter(Boolean)));
    if (!trees.get(sha).has(path)) return null;
    const key = `${sha}:${path}`;
    if (!digests.has(key)) digests.set(key, createHash('sha256').update(raw('show', key)).digest('hex'));
    return digests.get(key);
  };
  const changed = raw('diff', '--name-only', '-z', '--no-renames', proof.baseline, proof.head, '--').toString('utf8').split('\0').filter(Boolean);
  assert.deepEqual(changed.sort(), ['app.mjs', 'fixture.mjs'], 'independently fetched H contains exactly the authorized feature and additive test changes');
  assert.ok(Array.isArray(proof.mutations) && proof.mutations.length >= 2);
  const latest = new Map();
  for (const [index, mutation] of proof.mutations.entries()) {
    assert.equal(mutation.order, index + 1);
    assert.ok(changed.includes(mutation.path), 'every recorded write belongs to this Ticket scope');
    assert.match(mutation.afterSha256, /^[a-f0-9]{64}$/);
    if (mutation.beforeSha256 !== null) assert.match(mutation.beforeSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(mutation.beforeSha256, mutation.afterSha256, 'no-op calls are not completed mutations');
    const before = latest.has(mutation.path) ? latest.get(mutation.path) : digest(proof.baseline, mutation.path);
    assert.equal(mutation.beforeSha256, before, `raw baseline or preceding write must anchor ${mutation.path}`);
    assert.equal(mutation.matchesDeliveredFile, mutation.afterSha256 === digest(report.codeSha, mutation.path));
    latest.set(mutation.path, mutation.afterSha256);
  }
  assert.deepEqual([...latest.keys()].sort(), changed, 'the mutation chain covers every changed Git file');
  for (const [path, hash] of latest) assert.equal(hash, digest(proof.head, path), `the last completed write equals the raw H blob for ${path}`);
}
function verifyApprovedContext(f, report) {
  const start = f.confirmation.indexOf('\n{');
  assert.ok(start >= 0, 'actual user confirmation contains the approved snapshot');
  const approved = JSON.parse(f.confirmation.slice(start + 1));
  const context = report.approvedContext;
  assert.equal(context.schema, 1); assert.equal(context.source, 'controller-approved-snapshot');
  assert.equal(context.scopeDigest, report.scopeDigest);
  assert.equal(report.scopeDigest, createHash('sha256').update(JSON.stringify(approved)).digest('hex'));
  const checkText = (field, original) => {
    assert.equal(field.sha256, createHash('sha256').update(original).digest('hex'));
    assert.ok(Array.isArray(field.redactions));
    assert.equal(typeof field.text, 'string');
    for (const item of field.redactions) {
      assert.deepEqual(Object.keys(item).sort(), ['count', 'kind']);
      assert.ok(Number.isSafeInteger(item.count) && item.count > 0);
      assert.ok(field.text.includes(`[REDACTED:${item.kind}]`));
    }
    if (!field.redactions.length) assert.equal(field.text, original, 'safe approved text is preserved exactly');
  };
  const approvedTicket = approved.plan.tickets.find(item => item.issue.number === f.ticket.number);
  for (const [saved, original] of [[context.spec, approved.plan.spec], [context.ticket, approvedTicket.issue]]) {
    assert.equal(saved.number, original.number); assert.equal(saved.url, `https://github.com/${repository}/issues/${original.number}`);
    checkText(saved.title, original.title); checkText(saved.body, original.body);
    assert.deepEqual(saved.title.redactions, []);
  }
  assert.deepEqual(context.ticket.body.redactions, []);
  assert.deepEqual(context.ticket.dependencies, approvedTicket.dependencies);
  assert.deepEqual(context.approvedChanges, [], 'discussion or model text cannot invent an approved change');
  assert.equal(context.instructions.length, approved.instructions.length);
  for (const [index, original] of approved.instructions.entries()) {
    const saved = context.instructions[index]; checkText(saved.path, original.path); checkText(saved.content, original.content);
    assert.deepEqual(saved.path.redactions, []); assert.deepEqual(saved.content.redactions, []);
    assert.deepEqual(saved.roles, ['implementation', 'review'].filter(role => approved.contract.agents[role].instructions.includes(original.path)));
  }
  assert.equal(context.contract.source, '.pi/flow.json');
  checkText(context.contract.snapshot, JSON.stringify(approved.contract, null, 2));
  assert.deepEqual(context.contract.snapshot.redactions, []);
  assert.match(context.redactionBoundary, /cannot be detected completely/);
  if (f.privacy) {
    for (const marker of privacyMarkers) assert.ok(!JSON.stringify(report).includes(marker), 'downloaded public report contains no synthetic sensitive value');
    const redactions = context.spec.body.redactions;
    for (const kind of ['credential-assignment', 'authorization', 'credential-url', 'private-path']) assert.equal(redactions.find(item => item.kind === kind)?.count, 1);
    assert.ok(context.spec.body.text.startsWith(approved.plan.spec.body.split(privacyNote)[0]), 'all effective requirements remain readable before the non-functional privacy examples');
    assert.ok(context.spec.body.text.includes(`[Public evidence reference](${publicReference})`), 'a strict public GitHub comment reference remains auditable');
  } else assert.deepEqual(context.spec.body.redactions, []);
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
  verifyApprovedContext(f, report);
  verifyImplementationEvidence(f, report);
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
  assert.deepEqual(runGreeting(cwd, '\u00a0Ada\u2003'), { exitCode: 0, stdout: 'Hello, \u00a0Ada\u2003!\n' });
  for (const name of ['   ', '\t', '\t \t', '\f', '\v', '\u00a0', '\u2003', ' \t\f\v\u00a0\u2003', 'Ada\rLovelace', 'Ada\nLovelace']) {
    assert.deepEqual(runGreeting(cwd, name), { exitCode: 2, stdout: '' });
  }
  assert.deepEqual(runGreeting(cwd), { exitCode: 2, stdout: '' });
  assert.deepEqual(git(cwd, 'diff', '--name-only', f.baseline, sha).split('\n'), ['app.mjs', 'fixture.mjs']);
}
