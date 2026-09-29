import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export const whitespaceCases = [['space', ' '], ['tab', '\t'], ['form-feed', '\f'], ['nbsp', '\u00a0'], ['em-space', '\u2003']];
export function contextOf(input) {
  for (const message of input.messages.filter(item => item.role === 'user').reverse()) {
    const text = typeof message.content === 'string' ? message.content : message.content.map(item => item.text ?? '').join('\n');
    const start = text.indexOf('{'); let quoted = false; let escaped = false; let depth = 0;
    for (let i = start; i >= 0 && i < text.length; i += 1) {
      const char = text[i];
      if (escaped) { escaped = false; continue; }
      if (quoted && char === '\\') { escaped = true; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (!quoted && char === '{') depth += 1;
      if (!quoted && char === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('Controller supplied JSON context is required');
}
export async function repairFiles(project) {
  const original = await readFile(join(project, 'app.mjs'), 'utf8');
  const fixture = await readFile(join(project, 'fixture.mjs'), 'utf8');
  const start = fixture.indexOf('  process.stdout.write(JSON.stringify({ passed: true, assertions: [');
  assert.ok(start >= 0);
  const closing = "  ] }) + '\\n');";
  const end = fixture.indexOf(closing, start) + closing.length;
  assert.ok(end > start);
  const assertions = `  const assertions = [
    { name: 'greeting-for-name', passed: true },
    { name: 'missing-name-rejected', passed: true },
    ...${JSON.stringify(whitespaceCases)}.map(([id, name]) => {
      let passed = false;
      try { execFileSync(process.execPath, ['app.mjs', name], { stdio: 'pipe' }); }
      catch (error) { passed = error.status === 2 && error.stdout.length === 0; }
      return { name: 'blank-' + id + '-rejected', passed };
    }),
  ];
  if (assertions.some(item => !item.passed)) {
    process.stdout.write(JSON.stringify({ schema: 'flow-command-failure-v1', kind: 'behavior', codeSha: process.env.FLOW_CODE_SHA, assertions }));
    process.exitCode = 1;
  } else process.stdout.write(JSON.stringify({ passed: true, assertions }));`;
  return { original, fixture, acceptance: fixture.slice(0, start) + assertions + fixture.slice(end),
    app(count, noise = false) {
      const rejection = count === 5 ? '!name.trim() || ' : count > 0 ? `${JSON.stringify(whitespaceCases.slice(0, count).map(item => item[1]))}.includes(name) || ` : '';
      return original.replace('if (!name ||', `if (!name || ${rejection}`) + (noise ? '\n// Synthetic unrelated comment; behavior intentionally unchanged.\n' : '');
    } };
}
function reservedApp(content) { return content.replace('if (!name ||', "if (!name || name === 'Reserved' ||"); }
function addReservedCheck(source) {
  const insertion = source.indexOf('  const assertions = [');
  const legacy = source.indexOf('  process.stdout.write(JSON.stringify({ passed: true, assertions: [');
  const at = insertion >= 0 ? insertion : legacy;
  assert.ok(at >= 0);
  const check = `  let reservedRejected = false;
  try { execFileSync(process.execPath, ['app.mjs', 'Reserved'], { stdio: 'pipe' }); }
  catch (error) { reservedRejected = error.status === 2 && error.stdout.length === 0; }
  if (!reservedRejected) throw new Error('reserved-name contract failed');
`;
  return (source.slice(0, at) + check + source.slice(at)).replace("    { name: 'missing-name-rejected', passed: true },", "    { name: 'missing-name-rejected', passed: true },\n    { name: 'reserved-name-rejected', passed: true },");
}
function reviewedApp(files, count) {
  if (!count) return files.app(5);
  return files.app(5).replace('process.exitCode = 2;', `{ process.exitCode = 2; if (name && !name.trim()) process.stderr.write(${JSON.stringify(count === 1 ? 'blank name\n' : 'blank name\nUsage: app.mjs NAME\n')}); }`);
}
const call = (path, content) => ({ name: 'write', arguments: { path, content } });
export async function repairProvider(t, scenario) {
  let files; let initialCalls; let failure;
  let upstream; let releaseUpstream;
  const barrier = { targetObserved: false, upstreamSubmission: undefined };
  const upstreamSubmitted = new Promise(resolve => { releaseUpstream = resolve; });
  let repairs = 0;
  const requests = []; const reviews = [];
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      assert.ok(body.length < 4_000_000);
      if (req.url === '/_fixture/upstream-submitted') {
        const fact = JSON.parse(body);
        assert.equal(scenario, 'conflict-repair'); assert.equal(fact.ticket, upstream);
        assert.match(fact.head, /^[a-f0-9]{40}$/); assert.equal(fact.state, 'submitted');
        assert.equal(barrier.upstreamSubmission, undefined); barrier.upstreamSubmission = fact;
        releaseUpstream(); res.writeHead(204); res.end(); return;
      }
      assert.equal(req.headers.authorization === 'Bearer synthetic-local-only', true, 'model fixture must receive only its synthetic credential');
      const input = JSON.parse(body); const context = contextOf(input);
      const role = (input.tools ?? []).some(item => item.function?.name === 'write') ? 'implementation' : 'review';
      const prior = input.messages.filter(item => item.role === 'tool');
      const repair = context.task === 'repair-candidate';
      requests.push({ role, repair, codeSha: context.codeSha ?? null });
      let calls; let answer;
      if (role === 'implementation') {
        if (!prior.length) {
          if (repair) repairs += 1;
          if (repair && scenario === 'repair-needs-decision') answer = { kind: 'blocked', question: 'A stakeholder decision is required before choosing a new interpretation; no file changed.' };
          else if (repair && scenario === 'no-progress-no-diff') answer = { kind: 'implemented', summary: 'No effective change was made.' };
          else if (scenario === 'conflict-repair') {
            const upstream = context.ticket.issue.body.includes('UPSTREAM_RESERVED');
            if (!repair && !upstream) {
              barrier.targetObserved = true;
              let timer;
              try { await Promise.race([upstreamSubmitted, new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Actual upstream submission notification did not arrive')), 120_000);
              })]); } finally { clearTimeout(timer); }
            }
            calls = !repair ? upstream ? [call('fixture.mjs', addReservedCheck(files.fixture)), call('app.mjs', reservedApp(files.original))]
              : [call('fixture.mjs', files.acceptance), call('app.mjs', files.original.replace('if (!name ||', 'if (!name || false ||'))]
              : context.failure.kind === 'text-conflict'
                ? [call('fixture.mjs', addReservedCheck(files.acceptance)), call('app.mjs', reservedApp(files.original))]
                : [call('app.mjs', reservedApp(files.app(5)))];
          } else if (scenario === 'review-progress') {
            calls = repair ? [call('app.mjs', reviewedApp(files, repairs))]
              : [...initialCalls, call('app.mjs', reviewedApp(files, 0))];
          } else calls = repair ? [call('app.mjs', files.app(
            scenario === 'no-progress-noise' ? 0 : scenario === 'progressive-five' ? repairs : 5,
            scenario === 'no-progress-noise'))] : initialCalls;
        } else answer = { kind: 'implemented', summary: 'Preserved the original assertions and implemented only the assigned synthetic contract.' };
      } else {
        answer = { kind: 'review', codeSha: context.codeSha, scopeDigest: context.scopeDigest, blockers: [], suggestions: [] };
        if (context.previousBlockers?.length) answer.resolutions = context.previousBlockers.map(old => ({ ref: old.ref,
          status: 'resolved', basis: 'The current app blob contains the required behavior fix and the executable acceptance remains intact.',
          evidence: [{ path: 'app.mjs', blobSha256: createHash('sha256').update(files.app(5)).digest('hex') }] }));
        if (scenario === 'review-progress') {
          const findings = [
            { category: 'spec', basis: 'Blank-name rejection omits the required blank name diagnostic.', impact: 'The caller cannot identify its invalid blank name.', verification: 'Emit blank name on stderr for rejected blank names.' },
            { category: 'spec', basis: 'Blank-name rejection omits the required Usage: app.mjs NAME guidance.', impact: 'The caller cannot discover the accepted invocation.', verification: 'Emit Usage: app.mjs NAME on stderr for rejected blank names.' },
          ];
          if (!context.previousBlockers?.length && !repairs) answer.blockers = findings;
          else answer.resolutions = (context.previousBlockers ?? []).map(old => {
            const resolved = repairs >= 2 || old.blocker.basis.includes('diagnostic');
            return { ref: old.ref, status: resolved ? 'resolved' : 'unresolved',
              basis: resolved ? 'The required diagnostic now occurs in the actual changed app blob.' : 'The usage guidance is still absent from the current app.',
              evidence: resolved ? [{ path: 'app.mjs', blobSha256: createHash('sha256').update(reviewedApp(files, repairs)).digest('hex') }] : [] };
          });
        }
        reviews.push(answer);
      }
      const base = { id: `repair-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixed' };
      const delta = calls ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `repair_${requests.length}_${index}`,
        type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { role: 'assistant', content: JSON.stringify(answer) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) { failure = error; res.writeHead(500); res.end('Synthetic provider contract failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const provider = { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-local-only',
    models: [{ id: 'fixed', reasoning: false, contextWindow: 64000, maxTokens: 16384 }] };
  return { requests, reviews, provider, barrier, barrierUrl: `http://127.0.0.1:${server.address().port}/_fixture/upstream-submitted`,
    model: { provider: 'flow-repair-fixture', id: 'fixed' }, config: { providers: { 'flow-repair-fixture': provider } },
    async configure(project, upstreamTicket) { upstream = upstreamTicket; files = await repairFiles(project); initialCalls = [{ name: 'write', arguments: { path: 'fixture.mjs', content: files.acceptance } }]; },
    assertHealthy() { if (failure) throw failure; },
  };
}
