import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPi } from './pi-client.mjs';

export const repository = 'nanzhi84/pi-implement-flow-acceptance';
export const model = { provider: process.env.PI_PROVIDER ?? 'openai-codex', id: process.env.PI_MODEL ?? 'gpt-6-astra' };
const evidenceName = process.env.FLOW_EXECUTION_ARTIFACT_PREFIX ?? 'execution';
if (!/^[a-z-]+$/.test(evidenceName)) throw new Error('Invalid evidence prefix');
export const created = [];
export const preserved = [];
try { preserved.push(...JSON.parse(await readFile(`artifacts/${evidenceName}-preserved.local.json`, 'utf8'))); } catch { /* First run has no local locator. */ }
export const results = [];
const outputOptions = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 };
export function git(cwd, ...args) {
  return execFileSync('git', args, { ...outputOptions, cwd }).trim();
}
export function api(path, data) {
  const args = ['api', path];
  if (data !== undefined) args.push('--method', 'POST', '--input', '-');
  return JSON.parse(execFileSync('gh', args, { ...outputOptions, input: data === undefined ? undefined : JSON.stringify(data) }));
}
export async function persist() {
  await mkdir('artifacts', { recursive: true });
  await writeFile(`artifacts/${evidenceName}-scenarios.json`, JSON.stringify({ results, created }, null, 2) + '\n');
  // Local-only failure locator; never included in published acceptance evidence.
  if (preserved.length) await writeFile(`artifacts/${evidenceName}-preserved.local.json`, JSON.stringify(preserved, null, 2) + '\n', { mode: 0o600 });
}
export async function waitFor(predicate, message, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

export async function fixture(t, scenario, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'flow-execution-')));
  const project = join(root, 'project');
  const agent = join(root, 'agent');
  const clients = [];
  let verified = false;
  const observedCodes = () => [...new Set(clients.flatMap(client => client.notices.flatMap(notice => [...notice.matchAll(/\b([A-Z][A-Z_]+):/g)].map(match => match[1]))))];
  t.after(async () => {
    try { for (const client of clients) await client.close(); }
    finally {
      if (verified && !options.preserveOnPass) await rm(root, { recursive: true, force: true });
      else {
        preserved.push({ scenario, root });
        if (!verified) results.push({ scenario, result: 'failed', observedCodes: observedCodes(), boundary: 'External assertions not completed; inspect test runner diagnostics and retained local fixture' });
      }
      await persist();
    }
  });
  execFileSync('git', ['clone', '--quiet', `https://github.com/${repository}.git`, project], outputOptions);
  await mkdir(agent);
  if (options.fixed) await writeFile(join(agent, 'models.json'), JSON.stringify(options.fixed.config));
  else {
    const source = process.env.FLOW_TEST_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent');
    for (const file of ['auth.json', 'models.json']) {
      const path = join(source, file);
      try { await access(path); } catch { continue; }
      await symlink(path, join(agent, file));
    }
  }
  const baseline = git(project, 'rev-parse', 'HEAD');
  const marker = `${options.stage ?? 'T2'} acceptance ${scenario} ${Date.now()}`;
  const spec = api(`repos/${repository}/issues`, {
    title: `[Synthetic] ${marker}`,
    body: options.specBody ?? `## Problem Statement\n\nIsolated T2 execution acceptance for the existing synthetic greeting CLI. No production data. Preserve the existing project contract, publisher, acceptance fixtures and main branch.\n\n## Acceptance criteria\n\n- Deliver the single Ticket using its explicit behavior contract.\n- Preserve existing Ada greeting and missing-name rejection.\n- Leave Ticket PR unmerged and all Issues open.\n\nThis disposable planning fixture is retained as acceptance evidence.`,
  });
  created.push({ scenario, kind: 'spec', number: spec.number, url: spec.html_url });
  await persist();
  const requests = {
    ambiguity: 'The greeting must become either uppercase HELLO or lowercase hello. No stakeholder has chosen which option. This choice is intentionally unresolved: ask which one is required before the first file edit, then stop with a blocked result. Do not guess and do not alter files.',
    'no-diff': 'The current Ada greeting already satisfies this Ticket. Inspect the requirement and report implementation complete without changing any file. This scenario verifies that the orchestrator refuses to create an empty commit or PR.',
    cancellation: 'This synthetic Ticket will be cancelled while the implementation Agent is running. A model result arriving after cancellation cannot authorize Git or GitHub writes. Do not edit files.',
  };
  const ticket = api(`repos/${repository}/issues`, {
    title: `[Synthetic] ${marker} Ticket`,
    body: options.ticketBody?.(spec.number) ?? `## What to build\n\n${options.ticketRequest ?? requests[scenario]}\n\nPart of #${spec.number}.\n\n## Acceptance criteria\n\n- Observe the explicit stop condition described above.\n- node app.mjs Ada emits exactly Hello, Ada! followed by one newline.\n- node app.mjs with no name still exits 2.\n\n## Blocked by\n\nNone`,
  });
  created.push({ scenario, kind: 'ticket', number: ticket.number, url: ticket.html_url });
  await persist();
  api(`repos/${repository}/issues/${spec.number}/sub_issues`, { sub_issue_id: ticket.id });
  const f = {
    project, baseline, spec, ticket, feature: `flow/spec-${spec.number}`,
    async open(extra = {}) {
      const pi = await openPi(project, agent, { model: options.fixed?.model ?? model, timeoutMs: 900_000, ...extra });
      clients.push(pi);
      return pi;
    },
    pulls() { return api(`repos/${repository}/pulls?state=all&base=${encodeURIComponent(f.feature)}&per_page=100`); },
    verifyInvariants(ticketState = 'open') {
      assert.equal(api(`repos/${repository}/branches/main`).commit.sha, baseline, 'remote main must be unchanged');
      assert.equal(api(`repos/${repository}/issues/${spec.number}`).state, 'open');
      assert.equal(api(`repos/${repository}/issues/${ticket.number}`).state, ticketState);
      assert.equal(git(project, 'rev-parse', 'HEAD'), baseline, 'original checkout HEAD must be unchanged');
      assert.equal(git(project, 'status', '--porcelain'), '', 'original checkout must remain clean');
    },
    worktrees() {
      return git(project, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
    },
    verifyNoDiff() {
      for (const cwd of f.worktrees()) {
        assert.equal(git(cwd, 'rev-parse', 'HEAD'), baseline, 'no empty implementation commit');
        assert.equal(git(cwd, 'status', '--porcelain'), '', 'no unexpected implementation edits');
      }
      assert.equal(f.pulls().length, 0, 'no Ticket PR created');
      f.verifyInvariants();
    },
    pass(result) {
      results.push({ scenario, result: 'passed', observedCodes: observedCodes(), modelBoundary: options.fixed ? 'fixed loopback HTTP response; real pi/SDK/GitHub' : 'real selected model; real pi/SDK/GitHub', spec: spec.html_url, ticket: ticket.html_url, baseline, ...result });
      verified = true;
    },
  };
  return f;
}

export function runGreeting(cwd, ...args) {
  const result = spawnSync(process.execPath, ['app.mjs', ...args], { ...outputOptions, cwd });
  assert.equal(result.error, undefined);
  return { exitCode: result.status, stdout: result.stdout };
}

// A local transport fixture only: production Agent/session/control/GitHub code is unchanged.
// Delayed mode lets the server receive a real SDK request before a real session cancellation.
export async function fixedProvider(t, response, options = {}) {
  if (typeof options === 'boolean') options = { delayed: options };
  const requests = [];
  let pending;
  let emitted = false;
  function reply(res) {
    emitted = true;
    const base = { id: 'flow-test-response', object: 'chat.completion.chunk', created: 1, model: 'fixed' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const calls = requests.length === 1 ? options.toolCalls : undefined;
    const delta = calls ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `call_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { role: 'assistant', content: JSON.stringify(response) };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  }
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push({ model: input.model, messages: input.messages, tools: input.tools });
    await writeFile(`artifacts/${evidenceName}-provider-diagnostics.local.json`, JSON.stringify({ declaredToolNames: input.tools?.map(tool => tool.function?.name ?? tool.custom?.name), returnedToolNames: input.messages.filter(message => message.role === 'tool').map(message => ({ id: message.tool_call_id, found: !JSON.stringify(message.content).includes('not found') })) }, null, 2), { mode: 0o600 });
    await options.onRequest?.(requests.length);
    if (options.delayed) pending = res;
    else reply(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    requests,
    release() { assert.ok(pending, 'a model request must precede the late response'); reply(pending); },
    get emitted() { return emitted; },
    model: { provider: 'flow-acceptance', id: 'fixed' },
    config: { providers: { 'flow-acceptance': {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-local-only',
      models: [{ id: 'fixed', reasoning: false, contextWindow: 32000, maxTokens: 4096 }],
    } } },
  };
}
