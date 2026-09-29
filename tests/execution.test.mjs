import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { access, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { api, fixture, fixedProvider, persist, repository, waitFor } from './execution-fixture.mjs';

const selected = process.env.FLOW_EXECUTION_SCENARIO;
const skip = name => process.env.RUN_GITHUB_E2E !== '1' || (selected && selected !== name);

// These assertions were specified in docs/testing/t2-scenarios.md before execution code.
// The former success case is covered by integration.test.mjs real-integration.
// Its baseline, PR identity/context, business CLI, scope and main assertions are retained there.
test('real selected model stops on ambiguity before editing and records the question', { skip: skip('ambiguity'), timeout: 1_200_000 }, async t => {
  const f = await fixture(t, 'ambiguity');
  const pi = await f.open();
  const output = await pi.flow(`start ${f.spec.number}`, true);
  assert.match(output, new RegExp(`TICKET_BLOCKED: Ticket #${f.ticket.number}`));
  const comments = api(`repos/${repository}/issues/${f.ticket.number}/comments`);
  assert.ok(comments.length > 0, 'the decision question must be recorded remotely');
  const question = comments.find(comment => /HELLO|uppercase|lowercase|hello/i.test(comment.body));
  assert.ok(question, 'remote question preserves the unresolved product choice');
  f.verifyNoDiff();
  f.pass({ questionUrl: question.html_url, assertions: ['real model chose blocked outcome', 'question visible on Ticket', 'no file changes', 'no empty commit', 'no Ticket PR', 'Issues open', 'main unchanged'] });
});

test('an implemented response with no changes never creates an empty commit or PR', { skip: skip('no-diff'), timeout: 1_200_000 }, async t => {
  let f;
  let ownedLink;
  const toolCalls = [
    { name: 'bash', arguments: { command: 'git status' } },
    { name: 'bash', arguments: { command: 'gh issue list' } },
    { name: 'write', arguments: { path: '../escape.txt', content: 'Synthetic escape attempt' } },
    { name: 'read', arguments: { path: '.git' } },
    { name: 'read', arguments: { path: 'synthetic-external-link.txt' } },
  ];
  const fixed = await fixedProvider(t, { kind: 'implemented', summary: 'The existing greeting already satisfies the Ticket; no code was changed.' }, {
    toolCalls,
    async onRequest(number) {
      if (number === 1) {
        const workspace = f.worktrees().find(path => path !== f.project);
        assert.ok(workspace);
        const outside = join(f.project, '..', 'synthetic-private-sentinel.txt');
        await writeFile(outside, 'Synthetic sentinel outside assigned worktree');
        ownedLink = join(workspace, 'synthetic-external-link.txt');
        await symlink(outside, ownedLink);
      } else if (ownedLink) {
        await rm(ownedLink); // Remove only the link deliberately created by this fixture.
      }
    },
  });
  f = await fixture(t, 'no-diff', { fixed });
  const pi = await f.open();
  const output = await pi.flow(`start ${f.spec.number}`, true);
  assert.equal(fixed.requests.length, 2, 'real SDK sends tool results before terminal model response');
  const toolResults = fixed.requests[1].messages.filter(message => message.role === 'tool');
  assert.equal(toolResults.length, toolCalls.length);
  const declared = fixed.requests[0].tools.map(tool => tool.function.name);
  for (const [index, tool] of toolResults.entries()) {
    if (declared.includes(toolCalls[index].name)) assert.match(JSON.stringify(tool.content), /AGENT_TOOL_REFUSED|Path must stay|Only approved/);
    else assert.match(JSON.stringify(tool.content), new RegExp(`Tool ${toolCalls[index].name} not found`));
  }
  assert.equal(await readFile(join(f.project, '..', 'synthetic-private-sentinel.txt'), 'utf8'), 'Synthetic sentinel outside assigned worktree');
  for (const workspace of f.worktrees()) {
    await assert.rejects(access(join(workspace, '..', 'escape.txt')));
  }
  assert.match(output, new RegExp(`TICKET_NO_DIFF: Ticket #${f.ticket.number}`));
  assert.doesNotMatch(output, /TICKET_PR:/);
  const tools = fixed.requests[0].tools.map(tool => tool.function.name);
  assert.ok(tools.length > 0);
  assert.ok(tools.every(name => !['exec', 'shell', 'git', 'gh'].includes(name)), 'implementation context has no general execution/Git/GitHub tool');
  const commandTool = fixed.requests[0].tools.find(tool => tool.function.name === 'bash');
  if (commandTool) assert.match(commandTool.function.description, /Only approved|approved project command/);
  const request = fixed.requests[0].messages.map(message => typeof message.content === 'string'
    ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n')).join('\n');
  assert.ok(request.includes(JSON.stringify(f.ticket.body)));
  assert.ok(request.includes(JSON.stringify(f.spec.body)));
  assert.ok(request.includes('Do not change the execution contract'), 'explicit project instructions reach implementation context');
  f.verifyNoDiff();
  f.pass({ assertions: ['real SDK request captured without credentials', 'Spec/Ticket/instructions supplied', 'Git/GitHub shell calls unavailable under configured tool contract', '../ and .git paths refused', 'symlink access refused', 'external sentinel unchanged', 'empty result classified', 'no empty commit', 'no Ticket PR', 'Issues open', 'main unchanged'] });
});

test('session cancellation ignores a model success response emitted after pausing', { skip: skip('cancellation'), timeout: 1_200_000 }, async t => {
  const fixed = await fixedProvider(t, { kind: 'implemented', summary: 'Late result after the flow was cancelled.' }, true);
  const f = await fixture(t, 'cancellation', { fixed });
  const pi = await f.open();
  let completedOutput;
  const executing = pi.flow(`start ${f.spec.number}`, true);
  executing.then(output => { completedOutput = output; });
  await waitFor(() => {
    if (completedOutput !== undefined && fixed.requests.length === 0) throw new Error(`Flow stopped before implementation: ${completedOutput}`);
    return fixed.requests.length === 1;
  }, 'implementation model request was not reached', 600_000);
  assert.match(pi.notices.join('\n'), /AGENT_STARTED/);
  const transition = pi.request('new_session');
  await waitFor(() => pi.notices.some(notice => /FLOW_PAUSING/.test(notice)), 'real session transition did not pause the flow');
  fixed.release();
  assert.equal((await transition).success, true);
  await executing;
  assert.equal(fixed.emitted, true, 'test server emitted the stale result after cancellation started');
  assert.match(pi.notices.join('\n'), /FLOW_PAUSED/);
  assert.doesNotMatch(pi.notices.join('\n'), /TICKET_PR:/);
  assert.ok(f.worktrees().length > 1, 'cancelled Ticket worktree retained for reconciliation');
  f.verifyNoDiff();
  f.pass({ assertions: ['real SDK request pending before cancellation', 'real pi session switch', 'stale HTTP response attempted after FLOW_PAUSING; cancelled transport may refuse it', 'no Ticket PR', 'no empty commit', 'workspace retained', 'Issues open', 'main unchanged'] });
});

test.after(persist);
