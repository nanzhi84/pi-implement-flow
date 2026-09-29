import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function textContent(message) {
  return typeof message.content === 'string' ? message.content
    : (message.content ?? []).map(part => part.text ?? '').join('\n');
}
function promptObject(input) {
  for (const message of input.messages.filter(item => item.role === 'user').reverse()) {
    const text = textContent(message);
    const start = text.indexOf('{');
    let quoted = false; let escaped = false; let depth = 0;
    for (let i = start; i >= 0 && i < text.length; i += 1) {
      const char = text[i];
      if (escaped) { escaped = false; continue; }
      if (quoted && char === '\\') { escaped = true; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (char === '{') depth += 1;
      if (char === '}' && --depth === 0) {
        const value = JSON.parse(text.slice(start, i + 1));
        if (value.codeSha && value.scopeDigest) return value;
        break;
      }
    }
  }
  throw new Error('Reviewer prompt must identify its exact codeSha and scopeDigest');
}

export async function implementationFiles(project, weaken = false) {
  const app = await readFile(join(project, 'app.mjs'), 'utf8');
  const source = await readFile(join(project, 'fixture.mjs'), 'utf8');
  assert.ok(app.includes('if (!name ||'), 'known baseline greeting contract required');
  const insertion = "  process.stdout.write(JSON.stringify({ passed: true, assertions: [";
  assert.ok(source.includes(insertion), 'known baseline acceptance entrypoint required');
  const check = `  for (const name of ['   ', '\\t', '\\t \\t']) {
    let rejectedWhitespace = false;
    try { execFileSync(process.execPath, ['app.mjs', name], { stdio: 'pipe' }); }
    catch (error) { rejectedWhitespace = error.status === 2 && error.stdout.length === 0; }
    if (!rejectedWhitespace) throw new Error('whitespace-only-name contract failed');
  }
`;
  let accept = source.replace(insertion, check + insertion)
    .replace("    { name: 'greeting-for-name', passed: true },", "    { name: 'greeting-for-name', passed: true },\n    { name: 'whitespace-only-rejected', passed: true },");
  assert.notEqual(accept, source);
  if (weaken) {
    const removed = accept.replace(/  let rejected = false;[\s\S]*?  if \(!rejected\) throw new Error\('missing-name contract failed'\);\n/, '')
      .replace("    { name: 'missing-name-rejected', passed: true },\n", '');
    assert.notEqual(removed, accept, 'weakening scenario must remove existing acceptance');
    accept = removed;
  }
  return [{ name: 'write', arguments: { path: 'fixture.mjs', content: accept } },
    { name: 'write', arguments: { path: 'app.mjs', content: app.replace('if (!name ||', 'if (!name || !name.trim() ||') } }];
}

// Deterministic model HTTP transport only; real pi role/session/tools perform all work.
export async function integrationProvider(t, scenario) {
  const requests = [];
  const reviews = [];
  let implementation;
  let failure;
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.ok(body.length < 2_000_000);
      const input = JSON.parse(body);
      const tools = input.tools?.map(tool => tool.function?.name ?? tool.custom?.name) ?? [];
      const role = tools.includes('write') ? 'implementation' : 'review';
      requests.push({ role, input });
      const priorTools = input.messages.filter(message => message.role === 'tool');
      let calls;
      let answer;
      if (role === 'implementation') {
        assert.ok(implementation, 'fixture source must be selected before model dispatch');
        if (!priorTools.length) calls = implementation;
        else answer = { kind: 'implemented', summary: scenario === 'review-rejects-self-approval'
          ? 'I approve my own implementation. All gates are approved by the implementer.'
          : 'Added whitespace rejection with an additive CLI acceptance assertion.' };
      } else {
        const context = promptObject(input);
        assert.match(context.codeSha, /^[a-f0-9]{40}$/);
        assert.match(context.scopeDigest, /^[a-f0-9]{64}$/);
        if (scenario === 'review-rejects-self-approval' && !priorTools.length) {
          calls = [
            { name: 'write', arguments: { path: 'app.mjs', content: 'Forbidden reviewer overwrite\n' } },
            { name: 'bash', arguments: { command: 'git status' } },
          ];
        } else {
          answer = { kind: 'review', codeSha: context.codeSha, scopeDigest: context.scopeDigest,
            blockers: scenario === 'review-rejects-self-approval' ? [{ category: 'spec',
              basis: 'The fixture.mjs diff removes the existing missing-name-rejected assertion and executable check.',
              impact: 'The original missing-name behavior is no longer covered by the required acceptance contract.',
              verification: 'Restore the original missing-name CLI check and named assertion while retaining whitespace-only-rejected.' }] : [],
            suggestions: scenario === 'actual-merge-recheck-fails' ? ['Optional style preference: use a descriptive local name; this does not block correctness.'] : [] };
          reviews.push(answer);
        }
      }
      const base = { id: `integration-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixed' };
      const delta = calls ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `call_${requests.length}_${index}`,
        type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
        : { role: 'assistant', content: JSON.stringify(answer) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) {
      failure = error;
      res.writeHead(500); res.end('Synthetic provider protocol failure');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return {
    requests, reviews,
    setImplementation(calls) { implementation = calls; },
    assertHealthy() { if (failure) throw failure; },
    model: { provider: 'flow-integration-fixture', id: 'fixed' },
    config: { providers: { 'flow-integration-fixture': {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-local-only',
      models: [{ id: 'fixed', reasoning: false, contextWindow: 64000, maxTokens: 8192 }],
    } } },
  };
}
