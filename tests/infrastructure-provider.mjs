import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// A real HTTP boundary consumed by the installed pi SDK, never a session mock.
export async function infrastructureProvider(t, mode) {
  const requests = [];
  let failure;
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      assert.equal(input.model, 'fixed');
      let status = 503;
      if (mode === 'model-permanent') status = 401;
      if (mode === 'model-quota') status = 429;
      if (mode === 'model-invalid' || (mode === 'model-transient' && requests.length > 0)) status = 200;
      requests.push({ status });
      if (status !== 200) {
        const code = status === 429 ? 'insufficient_quota' : status === 401 ? 'invalid_api_key' : 'service_unavailable';
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code, message: `${status} ${code}; FLOW_SYNTHETIC_SECRET_DO_NOT_PUBLISH` } }));
        return;
      }
      const answer = mode === 'model-invalid' ? 'not a valid JSON result'
        : JSON.stringify({ kind: 'blocked', question: 'Synthetic transport recovered. Which greeting wording should this deliberately ambiguous Ticket use?' });
      const base = { id: 'flow-infrastructure', object: 'chat.completion.chunk', created: 1, model: 'fixed' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) { failure = error; res.writeHead(500); res.end('Synthetic HTTP fixture protocol failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, assertHealthy() { if (failure) throw failure; },
    model: { provider: 'flow-infrastructure', id: 'fixed' },
    config: { providers: { 'flow-infrastructure': { api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-local-only',
      models: [{ id: 'fixed', reasoning: false, contextWindow: 32000, maxTokens: 4096 }] } } },
  };
}
