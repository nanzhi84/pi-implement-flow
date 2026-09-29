import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { textContent } from './integration-provider.mjs';

function context(input) {
  for (const message of input.messages.filter(item => item.role === 'user').reverse()) {
    const text = textContent(message); const start = text.indexOf('{');
    let quoted = false; let escaped = false; let depth = 0;
    for (let i = start; i >= 0 && i < text.length; i++) {
      const c = text[i];
      if (escaped) { escaped = false; continue; }
      if (quoted && c === '\\') { escaped = true; continue; }
      if (c === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (c === '{') depth++;
      if (c === '}' && --depth === 0) { const value = JSON.parse(text.slice(start, i + 1)); if (value.ticket) return value; break; }
    }
  }
  throw new Error('Versioned Ticket context missing from real SDK request');
}
export async function schedulingProvider(t, scenario, harness) {
  let tickets; let files; let failure; const requests = []; const reviews = [];
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) { body += chunk; assert.ok(body.length < 2_000_000); }
      const input = JSON.parse(body); const prompt = context(input);
      const number = prompt.ticket.issue.number;
      const key = Object.keys(tickets).find(key => tickets[key].number === number); assert.ok(key);
      const role = input.tools?.some(tool => tool.function?.name === 'write') ? 'implementation' : 'review';
      const tools = input.messages.filter(message => message.role === 'tool');
      requests.push({ ticket: number, role, codeSha: prompt.codeSha, sequence: harness.sequence() });
      let calls; let answer;
      if (role === 'implementation') {
        if (key === 'D') answer = { kind: 'blocked', question: 'Should the formatter use dashes or underscores? No approved choice exists; its downstream Ticket must wait.' };
        else if (!tools.length) calls = files[key];
        else {
          for (const tool of tools) assert.doesNotMatch(textContent(tool), /Error:|not found|Tool error/);
          if (scenario === 'latest-base-semantic-conflict' && key === 'B') await harness.waitDelivery(tickets.A.number);
          answer = { kind: 'implemented', summary: `Implemented the exact synthetic ${key} requirement with real SDK file tools.` };
        }
      } else {
        assert.equal(tools.length, 0, 'review context is fresh');
        assert.match(prompt.codeSha, /^[a-f0-9]{40}$/);
        answer = { kind: 'review', codeSha: prompt.codeSha, scopeDigest: prompt.scopeDigest, blockers: [], suggestions: [] };
        reviews.push({ ticket: number, phase: prompt.phase, codeSha: prompt.codeSha, scopeDigest: prompt.scopeDigest });
      }
      const base = { id: `scheduling-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixed' };
      const delta = calls ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `call_${requests.length}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
        : { role: 'assistant', content: JSON.stringify(answer) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) { failure = error; res.writeHead(500); res.end('Synthetic scheduling provider rejected its protocol'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, reviews, setup(value, edits) { tickets = value; files = edits; }, assertHealthy() { if (failure) throw failure; },
    model: { provider: 'flow-scheduling-fixture', id: 'fixed' },
    config: { providers: { 'flow-scheduling-fixture': { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-local-only', models: [{ id: 'fixed', reasoning: false, contextWindow: 64000, maxTokens: 8192 }] } } },
  };
}
