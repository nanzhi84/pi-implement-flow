import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { api, assertNoDelivery, commit, featureSha, git, integrationFixture, readGate,
  repository, ticketPull, totals, verifyRemoteBehavior, verifyVersionChain } from './integration-fixture.mjs';
import { persist, runGreeting } from './execution-fixture.mjs';
import { textContent } from './integration-provider.mjs';

const selected = process.env.FLOW_INTEGRATION_SCENARIO;
const skip = name => process.env.RUN_GITHUB_E2E !== '1' || (selected && selected !== name);
const options = name => ({ skip: skip(name), timeout: 1_800_000 });
function candidate(observed) {
  const found = observed.gates.filter(gate => gate.phase === 'candidate');
  assert.equal(found.length, 1, 'exactly one C may gain evidence');
  return found[0];
}
function assertTicketOrigin(f, observed) {
  const pr = observed.ticketAtCreation;
  assert.ok(pr, 'observe the original T2 PR before any gate can integrate it');
  assert.equal(pr.draft, true);
  assert.equal(pr.merged, false);
  assert.equal(pr.base.ref, f.feature);
  assert.equal(pr.base.sha, f.baseline);
  assert.notEqual(pr.head.ref, f.feature); assert.notEqual(pr.head.ref, 'main');
  assert.notEqual(pr.head.sha, f.baseline);
  assert.ok(pr.body.includes(`#${f.ticket.number}`) || pr.body.includes(f.ticket.html_url));
  assert.ok(pr.body.includes(`#${f.spec.number}`) || pr.body.includes(f.spec.html_url));
}

// Supersedes the T2 success test: all former external assertions are retained,
// then extended to additive acceptance, review, actual merge, evidence and Issue closure.
test('real OpenAI model delivers and independently reviews the actual integrated version', options('real-integration'), async t => {
  assert.equal(process.env.PI_PROVIDER, 'openai');
  assert.equal(process.env.PI_MODEL, 'gpt-6-astra');
  assert.ok(process.env.PI_BIN, 'explicit OpenAI-capable host pi is required');
  const f = await integrationFixture(t, 'real-integration');
  assert.deepEqual(runGreeting(f.project, '   '), { exitCode: 0, stdout: 'Hello,    !\n' });
  const output = await f.run();
  assert.equal(typeof f.confirmation, 'string', output);
  assert.match(f.confirmation, /whitespace/);
  assert.match(output, new RegExp(`AGENT_STARTED: Ticket #${f.ticket.number}`));
  assert.match(output, /TICKET_PR: https:\/\/github\.com\//);
  assert.match(output, /TICKET_DELIVERED:/);
  assert.match(await f.pi.flow('status'), /paused.*final-acceptance-not-installed/);
  const observed = await f.observer();
  assertTicketOrigin(f, observed);
  assert.equal(observed.totalBeforeIntegration, 0, 'no empty total PR before actual integration');
  assert.equal(observed.featureAtCandidate, f.baseline);
  const c = readGate(f, candidate(observed));
  const mutations = c.report.implementationEvidence.segments.flatMap((segment, segmentIndex) => segment.mutations.map(event => ({ ...event, segmentIndex })));
  const finalAcceptanceHash = mutations.filter(mutation => mutation.path === 'fixture.mjs').at(-1).afterSha256;
  const acceptanceWritten = mutations.find(mutation => mutation.path === 'fixture.mjs' && mutation.afterSha256 === finalAcceptanceHash);
  const implementationWritten = mutations.find(mutation => mutation.path === 'app.mjs');
  assert.ok(acceptanceWritten.segmentIndex < implementationWritten.segmentIndex || (acceptanceWritten.segmentIndex === implementationWritten.segmentIndex && acceptanceWritten.order < implementationWritten.order), 'the final delivered acceptance file was written before the first effective implementation change');
  assert.equal(acceptanceWritten.matchesDeliveredFile, true);
  const pr = ticketPull(f);
  assert.equal(pr.merged, true); assert.equal(pr.state, 'closed');
  const versions = verifyVersionChain(f, pr, c);
  let accepted = c;
  if (versions.C !== versions.M) {
    const actual = observed.gates.filter(gate => gate.phase === 'actual');
    assert.equal(actual.length, 1, 'different actual SHA requires its own full gate');
    accepted = readGate(f, actual[0]);
    assert.equal(accepted.report.codeSha, versions.M);
    assert.deepEqual(accepted.report.versions, versions);
    assert.notEqual(accepted.sha256, c.sha256);
    const sourceEvents = report => report.implementationEvidence.segments.map(segment => ({ ...segment, mutations: segment.mutations.map(({ matchesDeliveredFile, ...event }) => event) }));
    assert.deepEqual(sourceEvents(accepted.report), sourceEvents(c.report), 'C and M retain the same completed implementation write history');
  }
  assert.deepEqual(accepted.report.approvedContext, c.report.approvedContext, 'C and M retain the same readable controller-approved requirements and instructions');
  assert.equal(readGate(f, candidate(observed)).sha256, c.sha256, 'historical C report must retain its exact bytes');
  assert.deepEqual(observed.mergeRequests.map(request => ({ sha: request.sha, method: request.method })), [{ sha: versions.H, method: 'merge' }]);
  assert.equal(observed.closeRequests.length, 1);
  assert.ok(observed.closeRequests[0].sequence > observed.gates.at(-1).sequence, 'closure follows actual-version evidence');
  verifyRemoteBehavior(f, versions.M);
  const total = totals(f); assert.equal(total.length, 1); assert.equal(total[0].draft, true); assert.equal(total[0].state, 'open');
  assert.equal(total[0].base.ref, 'main'); assert.equal(total[0].head.sha, versions.M);
  f.verifyInvariants('closed');
  const comments = api(`repos/${repository}/issues/${f.ticket.number}/comments`);
  const delivery = comments.find(comment => comment.body.includes(versions.M) && comment.body.includes(accepted.url) && comment.body.includes(accepted.sha256));
  assert.ok(delivery, 'remote delivery record links actual M and its evidence');
  const totalComments = api(`repos/${repository}/issues/${total[0].number}/comments`);
  assert.ok(totalComments.some(comment => [delivery.html_url, pr.html_url, versions.M, c.url, accepted.url].every(value => comment.body.includes(value))),
    'Draft total PR is a review entrypoint linking the Ticket delivery record, Ticket PR, M and C/M evidence');
  f.pass({ versions, ticketPr: pr.html_url, totalPr: total[0].html_url,
    implementationEvidence: { baseline: c.report.implementationEvidence.origin, head: versions.H,
      mutations: mutations.length, finalAcceptanceWrittenAt: [acceptanceWritten.segmentIndex, acceptanceWritten.order], firstImplementationWrittenAt: [implementationWritten.segmentIndex, implementationWritten.order],
      boundary: 'Raw Git bytes independently anchor completed controlled writes; this proves final acceptance content was written first, not that a failing test ran first.' },
    evidence: [c, ...(accepted === c ? [] : [accepted])].map(item => ({ url: item.url, sha256: item.sha256, codeSha: item.report.codeSha })),
    assertions: ['original T2 baseline/PR identity/context/scope/main assertions retained', 'real OpenAI implementation and independent reviewer', 'new CLI assertion plus existing assertions executed', 'raw baseline/H blobs anchor complete mutation chains and changed-file coverage', 'final acceptance bytes written before first effective implementation mutation', 'C/M preserve source events and bind delivered-file matches to actual bytes', 'C/M retain the same readable approved Spec/Ticket/dependencies/instructions/contract snapshot verified against the fixture', 'C parents verified', 'merge constrained to H', 'actual M parents/tree verified', 'actual SHA revalidated when different', 'historic C bytes preserved', 'remote M rejects String.trim spaces/TAB/FF/VT/NBSP/U+2003 and preserves accepted name bytes; missing/CR/LF remain rejected', 'Ticket closes after gate evidence', 'controller attributes command definitions and isolated review source', 'Draft total links full delivery/evidence chain', 'Spec open; total PR Draft; main unchanged'] });
});

test('candidate executable acceptance failure cannot obtain integration eligibility', options('accept-failure'), async t => {
  const f = await integrationFixture(t, 'accept-failure');
  const output = await f.run(); const observed = await f.observer();
  assert.equal(observed.applied, 1);
  assert.ok(observed.commands.some(command => command.phase === 'candidate' && command.command === 'check'));
  assert.ok(observed.commands.some(command => command.phase === 'candidate' && command.command === 'accept'));
  assert.equal(observed.mergeRequests.length, 0);
  assertNoDelivery(f, output);
  f.pass({ injection: 'real C accept command completed then its child exited 1', assertions: ['real candidate check and accept reached', 'one deterministic command failure', 'no merge request', 'feature unchanged', 'Ticket open; no delivery'] });
});

test('independent read-only review rejects weakened acceptance and implementer self-approval', options('review-rejects-self-approval'), async t => {
  const f = await integrationFixture(t, 'review-rejects-self-approval');
  const output = await f.run(); const observed = await f.observer();
  const requests = f.fixed.requests.filter(request => request.role === 'review');
  assert.equal(requests.length, 2, 'reviewer requests forbidden writes then returns a blocker');
  const first = requests[0].input;
  assert.ok(first.tools.every(tool => !['write', 'edit', 'bash'].includes(tool.function.name)));
  assert.equal(first.messages.filter(message => message.role === 'assistant' || message.role === 'tool').length, 0, 'reviewer begins with independent conversation history');
  const context = first.messages.map(textContent).join('\n');
  assert.ok(context.includes(f.spec.title) && context.includes(f.ticket.title));
  assert.ok(context.includes('missing-name-rejected') && context.includes('fixture.mjs'), 'review input includes acceptance change evidence');
  const denied = requests[1].input.messages.filter(message => message.role === 'tool');
  assert.equal(denied.length, 2);
  for (const result of denied) assert.match(JSON.stringify(result.content), /not found|refused|not allowed/i);
  const review = f.fixed.reviews.at(-1);
  assert.equal(review.blockers.length, 1);
  for (const key of ['basis', 'impact', 'verification']) assert.ok(review.blockers[0][key].length > 20);
  assertNoDelivery(f, output);
  assert.equal(observed.mergeRequests.length, 0);
  for (const cwd of f.worktrees()) assert.equal(git(cwd, 'status', '--porcelain'), '', 'reviewer cannot alter candidate code');
  const comments = [...api(`repos/${repository}/issues/${f.ticket.number}/comments`), ...api(`repos/${repository}/issues/${observed.ticketAtCreation.number}/comments`)];
  assert.ok(comments.some(comment => ['basis', 'impact', 'verification'].every(key => comment.body.includes(review.blockers[0][key]))), 'full blocker is a remotely visible decision record');
  f.pass({ reviewCodeSha: review.codeSha, assertions: ['implementation self-approval supplies no qualification', 'independent review starts without implementation conversation', 'review gets Spec/diff/acceptance changes', 'write and shell tools unavailable', 'candidate code unchanged by reviewer', 'weakening blocker records basis/impact/verification', 'no merge; Ticket open'] });
});

test('unverifiable candidate artifact cannot be replaced by startup or historical evidence', options('evidence-unavailable'), async t => {
  const f = await integrationFixture(t, 'evidence-unavailable');
  const output = await f.run(); const observed = await f.observer();
  assert.equal(observed.applied, 1, 'real download corrupted once; no automatic re-publication loop');
  const fault = observed.byteFault;
  assert.equal(fault.repository, repository);
  assert.match(fault.tag, /^flow-evidence-[a-f0-9]{64}$/);
  assert.match(fault.filename, /^[A-Za-z0-9._-]+$/);
  const original = execFileSync('gh', ['release', 'download', fault.tag, '--repo', repository, '--pattern', fault.filename, '--output', '-'],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  const sentinel = Buffer.from('FLOW_UTF8_SENTINEL:\uFFFD:END');
  const start = original.indexOf(sentinel);
  assert.ok(start >= 0); assert.equal(original.indexOf(sentinel, start + 1), -1);
  const position = start + Buffer.byteLength('FLOW_UTF8_SENTINEL:');
  const corrupted = Buffer.concat([original.subarray(0, position), Buffer.from([0xff]), original.subarray(position + 3)]);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(original), fault.originalSha256); assert.equal(hash(corrupted), fault.corruptedSha256);
  assert.notEqual(fault.originalSha256, fault.corruptedSha256);
  assert.equal(original.length, fault.originalBytes); assert.equal(corrupted.length, fault.corruptedBytes);
  assert.equal(fault.decodedEqual, true); assert.equal(fault.invalidUtf8, true);
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(original));
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(corrupted), TypeError);
  assert.equal(corrupted.toString('utf8'), original.toString('utf8'), 'old text decoding would make the different raw bytes appear identical');
  assert.match(output, /EVIDENCE_INVALID:/, 'the raw-byte mismatch must reach controller evidence validation');
  assert.ok(f.fixed.reviews.some(review => review.blockers.length === 0));
  assert.equal(observed.gates.length, 0, 'C has no verified gate artifact');
  assert.equal(observed.mergeRequests.length, 0);
  assertNoDelivery(f, output);
  f.pass({ injection: 'real C evidence downloaded; unique UTF-8 EF BF BD sentinel replaced by invalid single FF byte; diagnostic marker is stderr only', byteFault: fault,
    assertions: ['actual commands and reviewer pass before evidence check', 'original remote asset independently downloaded unchanged', 'different raw hashes despite identical decoded text', 'invalid UTF-8 delivered to controller', 'one deterministic byte mismatch yields EVIDENCE_INVALID', 'no verified C evidence', 'startup evidence grants no merge', 'no merge; Ticket open'] });
});

for (const scenario of ['stale-head', 'stale-base']) {
  test(`candidate evidence loses eligibility after ${scenario}`, options(scenario), async t => {
    const f = await integrationFixture(t, scenario);
    const output = await f.run(); const observed = await f.observer();
    assert.equal(observed.applied, 1); assert.equal(observed.writes.length, 1);
    const drift = observed.writes[0];
    const gate = readGate(f, candidate(observed));
    assert.equal(observed.mergeRequests.length, 0, 'visible drift must refuse before requesting merge');
    const pr = assertNoDelivery(f, output, scenario === 'stale-base' ? drift.after : f.baseline);
    assert.equal(drift.before, scenario === 'stale-head' ? gate.report.versions.H : gate.report.versions.B);
    assert.notEqual(drift.after, drift.before);
    if (scenario === 'stale-head') assert.equal(pr.head.sha, drift.after);
    assert.equal(readGate(f, candidate(observed)).sha256, gate.sha256);
    f.pass({ drift, historicalEvidence: { url: gate.url, sha256: gate.sha256, versions: gate.report.versions },
      assertions: ['external synthetic writer advances after verified C', 'old evidence unchanged', 'new version receives no old eligibility', 'no merge request', 'external branch preserved', 'Ticket open; no delivery'] });
  });
}

test('nonblocking style review permits merge but equal-tree M still requires passing its own gate', options('actual-merge-recheck-fails'), async t => {
  const f = await integrationFixture(t, 'actual-merge-recheck-fails');
  const output = await f.run(); const observed = await f.observer();
  assert.equal(observed.applied, 1);
  const c = readGate(f, candidate(observed));
  assert.ok(c.report.review.suggestions.length > 0);
  const pr = ticketPull(f); assert.equal(pr.merged, true);
  const versions = verifyVersionChain(f, pr, c);
  assert.notEqual(versions.M, versions.C, 'this scenario must actually exercise a distinct merged commit');
  assert.ok(observed.commands.some(command => command.phase === 'actual' && command.command === 'accept' && command.sha === versions.M));
  assert.equal(observed.gates.filter(gate => gate.phase === 'actual').length, 0);
  assert.match(output, /INTEGRATED_UNACCEPTED/); assert.doesNotMatch(output, /TICKET_DELIVERED:/);
  assert.equal(observed.closeRequests.length, 0);
  for (const total of totals(f)) assert.equal(total.draft, true);
  f.verifyInvariants();
  f.pass({ versions, ticketPr: pr.html_url, evidence: { url: c.url, sha256: c.sha256 }, injection: 'real actual-M accept child returns failure after command completed',
    assertions: ['style-only suggestion did not block actual merge', 'M differs from C despite equal tree', 'actual-M commands execute', 'C evidence cannot approve M', 'merged fact retained as integrated-unaccepted', 'Ticket open; no close request or delivery; main unchanged'] });
});

test('actual-version review blockers persist on the merged PR with a navigable notification', options('actual-review-blockers-recorded'), async t => {
  const f = await integrationFixture(t, 'actual-review-blockers-recorded');
  const output = await f.run(); const observed = await f.observer();
  const c = readGate(f, candidate(observed));
  const pr = ticketPull(f);
  assert.equal(pr.merged, true); assert.equal(pr.state, 'closed');
  const versions = verifyVersionChain(f, pr, c);
  assert.notEqual(versions.M, versions.C, 'actual review must concern a distinct real merge commit');
  const requests = f.fixed.requests.filter(request => request.role === 'review');
  assert.equal(requests.length, 2);
  for (const request of requests) assert.equal(request.input.messages.filter(message => ['assistant', 'tool'].includes(message.role)).length, 0);
  assert.deepEqual(f.fixed.reviews.map(review => review.codeSha), [versions.C, versions.M]);
  assert.deepEqual(f.fixed.reviews[0].blockers, []);
  const review = f.fixed.reviews[1];
  assert.equal(review.scopeDigest, c.report.scopeDigest); assert.equal(review.blockers.length, 1);
  assert.equal(Buffer.byteLength(JSON.stringify(review), 'utf8'), 48_000, 'valid multilingual review reaches the public response byte budget');
  assert.ok(JSON.stringify(review).length < 48_000, 'UTF-8 budget is distinct from JavaScript character count');
  assert.ok(requests[1].input.messages.map(textContent).join('\n').includes('48000 UTF-8 bytes'), 'reviewer is told the enforced response budget');
  for (const phase of ['prepare', 'check', 'accept', 'cleanup']) assert.ok(observed.commands.some(command => command.phase === 'actual' && command.command === phase && command.sha === versions.M));
  assert.equal(observed.gates.filter(gate => gate.phase === 'actual').length, 0, 'C evidence cannot approve the rejected actual version');
  assert.equal(readGate(f, candidate(observed)).sha256, c.sha256, 'historical C evidence retains its exact bytes');
  const comments = api(`repos/${repository}/issues/${pr.number}/comments`);
  const findings = comments.filter(comment => comment.body.includes('Phase: `actual`')
    && comment.body.includes(`Version: \`${versions.M}\``) && comment.body.includes(`Scope: \`${review.scopeDigest}\``)
    && review.blockers.every(blocker => ['category', 'basis', 'impact', 'verification'].every(key => comment.body.includes(blocker[key]))));
  assert.equal(findings.length, 1, 'complete actual-version findings must be stored once on the real Ticket PR');
  assert.ok(Buffer.byteLength(findings[0].body, 'utf8') <= 60_000, 'full findings plus phase/version/scope fit one conservative comment budget');
  assert.doesNotMatch(output, /REMOTE_RESULT_UNKNOWN:/, 'valid bounded findings must not fail from oversized publication');
  assert.ok(findings[0].html_url.startsWith(`${pr.html_url}#issuecomment-`));
  assert.ok(output.includes(`REVIEW_FINDINGS: actual ${versions.M} ${findings[0].html_url}`), 'notification links the persisted version-bound review record');
  assert.match(output, /INTEGRATED_UNACCEPTED:/); assert.doesNotMatch(output, /TICKET_DELIVERED:/);
  const status = await f.pi.flow('status'); assert.match(status, /integrated-unaccepted/); assert.ok(status.includes(versions.M));
  assert.equal(observed.mergeRequests.length, 1, 'never merge again after an actual-version review blocker');
  assert.equal(observed.closeRequests.length, 0);
  const total = totals(f); assert.equal(total.length, 1); assert.equal(total[0].draft, true); assert.equal(total[0].state, 'open');
  assert.equal(total[0].head.sha, versions.M); assert.equal(total[0].base.ref, 'main');
  f.verifyInvariants();
  f.pass({ versions, ticketPr: pr.html_url, totalPr: total[0].html_url, findingsComment: findings[0].html_url,
    review: { phase: 'actual', codeSha: review.codeSha, scopeDigest: review.scopeDigest, blockers: review.blockers },
    candidateEvidence: { url: c.url, sha256: c.sha256 },
    injection: 'fixed HTTP reviewer passes C and returns one explicit multilingual blocker in an exact 48000-byte JSON result only in fresh actual-M SDK review; real GitHub merge and comment writes are unchanged',
    assertions: ['C independently passes before real GitHub merge', 'distinct M receives fresh review after actual commands', 'full actual phase/M/scope/category/basis/impact/verification persisted once on Ticket PR', '48000-byte UTF-8 review fits a complete single comment without truncation or unknown publication', 'reviewer prompt states the enforced byte budget', 'notification links the remotely readable findings', 'C evidence cannot substitute for failed actual review', 'merged parents/tree and feature M retained', 'status retains integrated-unaccepted and M', 'exactly one merge; no close request or delivery', 'Ticket/Spec open; total Draft; main unchanged'] });
});

test('oversized UTF-8 review stops before findings publication or merge', options('review-response-too-large'), async t => {
  const f = await integrationFixture(t, 'review-response-too-large');
  const output = await f.run(); const observed = await f.observer();
  const requests = f.fixed.requests.filter(request => request.role === 'review');
  assert.equal(requests.length, 1, 'invalid response is not retried in a new review');
  const review = f.fixed.reviews[0]; const response = JSON.stringify(review);
  assert.equal(Buffer.byteLength(response, 'utf8'), 48_001);
  assert.ok(response.length < 48_000, 'character-only validation would miss this oversized response');
  assert.ok(['basis', 'impact', 'verification'].every(key => review.blockers[0][key].length <= 20_000));
  assert.match(output, /AGENT_RESULT_INVALID:/); assert.doesNotMatch(output, /REVIEW_FINDINGS:|REMOTE_RESULT_UNKNOWN:/);
  assert.equal(observed.gates.length, 0, 'invalid candidate review grants no C evidence');
  assert.equal(observed.mergeRequests.length, 0); assert.equal(observed.closeRequests.length, 0);
  const pr = ticketPull(f);
  const comments = api(`repos/${repository}/issues/${pr.number}/comments`);
  assert.ok(comments.every(comment => !comment.body.includes('Independent review blocked')
    && !comment.body.includes(review.blockers[0].verification)), 'oversized findings are not submitted, truncated or split into remote comments');
  assertNoDelivery(f, output);
  f.pass({ ticketPr: pr.html_url, reviewCodeSha: review.codeSha,
    injection: 'real SDK candidate reviewer receives a fixed multilingual JSON result of 48001 UTF-8 bytes; GitHub writes remain real',
    assertions: ['response exceeds byte budget despite permitted character and field counts', 'one real SDK review then AGENT_RESULT_INVALID', 'no truncated or split findings comment', 'no C approval or merge/close request', 'Ticket/Spec open; feature and main unchanged; failed workspace retained'] });
});

test('a base race after final reads is reported as merged but unaccepted without rollback', options('base-race-after-final-read'), async t => {
  const f = await integrationFixture(t, 'base-race-after-final-read');
  const output = await f.run(); const observed = await f.observer();
  const c = readGate(f, candidate(observed));
  assert.equal(observed.writes.length, 1); assert.equal(observed.applied, 1);
  assert.equal(observed.mergeRequests.length, 1);
  const drift = observed.writes[0];
  assert.ok(drift.sequence > observed.mergeRequests[0].sequence, 'external write occurs inside merge transport dispatch after final revalidation');
  const pr = ticketPull(f); assert.equal(pr.merged, true, 'a rejected merge would not cover the required already-merged race');
  const merged = commit(pr.merge_commit_sha);
  assert.deepEqual(merged.parents.map(parent => parent.sha), [drift.after, c.report.versions.H]);
  assert.equal(drift.before, c.report.versions.B); assert.notEqual(drift.after, c.report.versions.B);
  assert.equal(featureSha(f), merged.sha, 'never force rollback the actual external result');
  assert.match(output, /INTEGRATED_UNACCEPTED/); assert.doesNotMatch(output, /TICKET_DELIVERED:/);
  assert.equal(observed.closeRequests.length, 0);
  f.verifyInvariants();
  f.pass({ ticketPr: pr.html_url, candidateVersions: c.report.versions, actualM: merged.sha, drift,
    assertions: ['C passed for old B/H', 'external B advances inside real merge dispatch', 'GitHub actually merged against B prime', 'parent mismatch detected after actual merge', 'integrated-unaccepted retains truth', 'no rollback; no Ticket closure or delivery'] });
});

test.after(persist);
