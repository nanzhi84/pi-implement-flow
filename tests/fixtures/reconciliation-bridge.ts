import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { repository, assertRepositoryIdentity } from '../acceptance-repository.mjs';
import { Remote } from '../../src/remote.ts';

// The extension only injects real CLI return boundaries. It never fabricates a
// successful GitHub response, mutates production modules, or persists a ledger.
export default function reconciliationBridge(pi) {
  let original;
  let installed;
  const wrapper = fileURLToPath(new URL('./reconciliation-command.mjs', import.meta.url));
  let configured = false;
  let config;
  let cwd;
  let ui;
  let originalNotify;
  const attempts = [];
  const applied = [];
  const seen = new Set();
  const digest = value => createHash('sha256').update(value).digest('hex');
  const api = path => JSON.parse(childProcess.execFileSync('gh', ['api', path], { cwd, encoding: 'utf8', stdio: 'pipe' }));
  const known = new Set();
  let queryAttempts = 0;
  function install() {
    installed = childProcess.spawn = function (command, args, options) {
      if (!configured || !Array.isArray(args)) return original.call(this, command, args, options);
      const endpoint = args.find(arg => typeof arg === 'string' && arg.startsWith(`repos/${repository}/`));
      const payloadIndex = args.indexOf('--input');
      const body = payloadIndex >= 0 ? JSON.parse(readFileSync(args[payloadIndex + 1], 'utf8')) : {};
      let key;
      if (command === 'git' && args[0] === 'push') {
        const target = args.find(arg => new RegExp(`^[a-f0-9]{40}:refs/heads/flow/(?:spec-${config.spec}|ticket-${config.spec}-${config.ticket})$`).test(arg));
        if (target) key = `push:${target.split(':')[1]}`;
      }
      if (command === 'gh' && endpoint === `repos/${repository}/pulls` && args.includes('POST')
        && [config.feature, `flow/ticket-${config.spec}-${config.ticket}`].includes(body.head)) key = `create-pr:${body.head}`;
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'ready' && known.has(Number(args[2]))) key = `ready:${args[2]}`;
      if (command === 'gh' && endpoint === `repos/${repository}/issues` && args.includes('POST')) key = 'create-child';
      if (command === 'gh' && endpoint === `repos/${repository}/issues/${config.spec}/sub_issues` && args.includes('POST')) key = `associate:${body.sub_issue_id}`;
      const match = endpoint && new RegExp(`^repos/${repository}/(issues|pulls)/(\\d+)(?:/(comments|merge))?$`).exec(endpoint);
      if (command === 'gh' && match && known.has(Number(match[2]))) {
        if (match[3] === 'merge' && args.includes('PUT')) key = `merge:${match[2]}`;
        if (match[3] === 'comments' && args.includes('POST')) key = `comment:${match[2]}:${digest(body.body)}`;
        if (!match[3] && args.includes('PATCH') && body.state === 'closed') key = `close:${match[2]}`;
      }
      if (options?.env?.FLOW_REPOSITORY === repository && args[0] === 'publish.mjs') {
        key = `publish:${options.env.FLOW_ARTIFACT_SHA256 ?? digest(readFileSync(options.env.FLOW_REPORT))}`;
      }
      if (config.mode === 'push-read-not-started' && applied.length && command === 'git' && args[0] === 'ls-remote' && args.includes(`refs/heads/${config.feature}`)) {
        queryAttempts++; return original.call(this, '/flow-synthetic-no-such-executable', [], options);
      }
      const queryFailure = applied.length && command === 'gh' && args.includes('GET') && endpoint
        && ((['pr-read-unavailable', 'pr-read-orphaned'].includes(config.mode) && endpoint.startsWith(`repos/${repository}/pulls?`))
          || (config.mode === 'merge-read-unavailable' && /\/pulls\/\d+$/.test(endpoint)));
      if (queryFailure) {
        queryAttempts++;
        return original.call(this, process.execPath, [wrapper, config.mode === 'pr-read-orphaned' ? 'read-orphaned' : 'read-unavailable', 'query', command, ...args], options);
      }
      if (!key) return original.call(this, command, args, options);
      const target = config.mode === 'applied-responses-lost'
        || (['push-not-sent', 'push-read-not-started'].includes(config.mode) && key === `push:refs/heads/${config.feature}`)
        || (['pr-read-unavailable', 'pr-read-orphaned'].includes(config.mode) && key.startsWith('create-pr:flow/ticket-'))
        || (config.mode === 'merge-read-unavailable' && key.startsWith('merge:'))
        || (config.mode.startsWith('publisher-') && key.startsWith('publish:'))
        || (['derived-association-lost', 'derived-association-drift'].includes(config.mode) && key.startsWith('associate:'))
        || (config.mode === 'derived-create-unresolved' && key === 'create-child');
      if (!target) return original.call(this, command, args, options);
      attempts.push({ key });
      if (seen.has(key)) throw new Error('Unexpected duplicate semantic write');
      seen.add(key);
      if (config.mode === 'push-not-sent') return original.call(this, '/flow-synthetic-no-such-executable', [], options);
      const mode = config.mode.startsWith('publisher-') || ['derived-association-drift', 'push-read-not-started'].includes(config.mode) ? config.mode : 'lose-response';
      const child = original.call(this, process.execPath, [wrapper, mode, key, command, ...args], options);
      let diagnostic = '';
      child.stderr?.on('data', chunk => {
        diagnostic += chunk;
        const found = /RECONCILIATION_APPLIED: (\{[^\n]*\})\n/.exec(diagnostic);
        if (found && !applied.some(item => item.key === key)) {
          const fact = JSON.parse(found[1]); applied.push(fact);
          if (fact.number) known.add(fact.number);
        }
        if (diagnostic.length > 16384) diagnostic = diagnostic.slice(-8192);
      });
      return child;
    };
    syncBuiltinESMExports();
  }
  pi.registerCommand('fixture-reconciliation', { handler: async (text, ctx) => {
    if (configured) throw new Error('Only one fixture configuration');
    config = JSON.parse(text); cwd = ctx.cwd;
    if (config.repository !== repository || repository !== 'nanzhi84/pi-implement-flow-reconciliation-acceptance'
      || ![config.spec, config.ticket].every(n => Number.isSafeInteger(n) && n > 0)
      || !['applied-responses-lost', 'push-not-sent', 'push-read-not-started', 'pr-read-unavailable', 'pr-read-orphaned', 'merge-read-unavailable',
        'publisher-partial', 'publisher-bytes-mismatch', 'publisher-source-drift', 'publisher-wrong-tag', 'derived-association-lost', 'derived-association-drift', 'derived-create-unresolved'].includes(config.mode)) throw new Error('Unsafe reconciliation fixture');
    assertRepositoryIdentity(api(`repos/${repository}`));
    const origin = childProcess.execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' }).trim();
    if (origin !== `https://github.com/${repository}.git`) throw new Error('Unexpected fixture clone');
    config.feature = `flow/spec-${config.spec}`; known.add(config.ticket); known.add(config.spec);
    ui = ctx.ui; originalNotify = ui.notify;
    ui.notify = (message, ...args) => {
      for (const match of String(message).matchAll(new RegExp(`https://github.com/${repository}/pull/(\\d+)`, 'g'))) known.add(Number(match[1]));
      return originalNotify.call(ui, message, ...args);
    };
    original = childProcess.spawn; // Preserve the already-armed integration observer.
    configured = true; install();
  } });
  pi.registerCommand('fixture-reconciliation-status', { handler: async (_text, ctx) => {
    ctx.ui.notify(`RECONCILIATION_OBSERVER: ${JSON.stringify({ mode: config?.mode, attempts, applied, queryAttempts })}`, 'info');
  } });
  pi.registerCommand('fixture-reconciliation-derived', { handler: async (_text, ctx) => {
    if (!configured || !config.mode.startsWith('derived-')) throw new Error('Derived fixture was not approved');
    const remote = new Remote(cwd, repository);
    try {
      const child = await remote.createChildIssue(config.spec, '[Synthetic] Derived operation boundary',
        `## What to build\n\nSynthetic adapter acceptance; no implementation requested. Part of #${config.spec}.\n\n## Acceptance criteria\n\n- Preserve exact native parent association.\n\n## Blocked by\n\nNone`);
      ctx.ui.notify(`DERIVED_CONFIRMED: ${child.number}`, 'info');
    } catch (error) { ctx.ui.notify(`DERIVED_STOPPED: ${error.code ?? 'unclassified'}`, 'error'); }
  } });
  pi.on('session_shutdown', () => {
    if (childProcess.spawn === installed) childProcess.spawn = original;
    if (ui && originalNotify) ui.notify = originalNotify;
    syncBuiltinESMExports();
  });
}
