import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Observes actual UI/CLI boundaries. No production module or GitHub result is mocked.
export default function integrationBridge(pi) {
  const key = Symbol.for('pi-flow.test.integration-bridge.v1');
  const state = globalThis[key] ??= {
    spawn: childProcess.spawn, configured: false, sequence: 0, gates: [],
    mergeRequests: [], closeRequests: [], commands: [], writes: [], applied: 0,
  };
  const run = (command, args, input, env) => childProcess.execFileSync(command, args, {
    cwd: state.cwd, input, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const api = path => JSON.parse(run('gh', ['api', `repos/${state.repository}/${path}`]));
  const git = (...args) => run('git', args);
  function pull() {
    const found = api(`pulls?state=all&base=${encodeURIComponent(state.feature)}`);
    if (found.length !== 1 || found[0].head.repo.full_name !== state.repository) throw new Error('Synthetic PR is not uniquely identified');
    return found[0];
  }
  function advance(target) {
    if (state.writes.length) throw new Error('Each synthetic drift runs once');
    const pr = pull();
    const ref = target === 'head' ? pr.head.ref : state.feature;
    if (ref === 'main' || (target === 'head' && !ref.includes(String(state.spec)))) throw new Error('Unsafe fixture branch');
    git('fetch', '--quiet', 'origin', ref);
    const before = git('rev-parse', 'FETCH_HEAD');
    const temporary = mkdtempSync(join(tmpdir(), 'flow-integration-index-'));
    const env = { GIT_INDEX_FILE: join(temporary, 'index') };
    let after;
    try {
      run('git', ['read-tree', before], undefined, env);
      const blob = run('git', ['hash-object', '-w', '--stdin'], `Synthetic ${state.mode} external writer\n`);
      run('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},integration-external-drift.txt`], undefined, env);
      const tree = run('git', ['write-tree'], undefined, env);
      after = run('git', ['commit-tree', tree, '-p', before], `Synthetic ${state.mode} external writer\n`);
      git('push', '--quiet', 'origin', `${after}:refs/heads/${ref}`);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    if (api(`git/ref/heads/${ref}`).object.sha !== after) throw new Error('Synthetic branch advance was not confirmed');
    state.writes.push({ target, ref, before, after, sequence: ++state.sequence });
    state.applied += 1;
  }
  function observe(message) {
    const sequence = ++state.sequence;
    const started = /^GATE_STARTED: (candidate|actual) ([a-f0-9]{40})/.exec(message);
    if (started) state.currentGate = { phase: started[1], sha: started[2] };
    const ticket = /^TICKET_PR: (https:\/\/github\.com\/[^\s]+)/.exec(message);
    if (ticket) {
      const pr = pull();
      state.ticketAtCreation = { url: pr.html_url, number: pr.number, head: { ref: pr.head.ref, sha: pr.head.sha }, base: { ref: pr.base.ref, sha: pr.base.sha },
        draft: pr.draft, merged: !!pr.merged_at, body: pr.body, sequence };
    }
    const passed = /^GATE_PASSED: (candidate|actual) ([a-f0-9]{40}) (https:\/\/github\.com\/[^\s]+)/.exec(message);
    if (passed) {
      const [phase, sha, url] = passed.slice(1);
      state.gates.push({ phase, sha, url, sequence });
      if (phase === 'candidate') {
        state.featureAtCandidate = api(`git/ref/heads/${state.feature}`).object.sha;
        state.totalBeforeIntegration = api(`pulls?state=all&head=${encodeURIComponent(`nanzhi84:${state.feature}`)}&base=main`).length;
        if (state.mode === 'stale-head') advance('head');
        if (state.mode === 'stale-base') advance('base');
      }
    }
  }
  function install(ctx) {
    if (!state.ui) {
      state.ui = ctx.ui;
      state.notify = ctx.ui.notify;
      state.wrappedNotify = (message, ...args) => {
        if (state.configured) observe(message);
        return state.notify.call(state.ui, message, ...args);
      };
      ctx.ui.notify = state.wrappedNotify;
    }
    childProcess.spawn = function (command, args, options) {
      if (!state.configured) return state.spawn.call(this, command, args, options);
      const path = Array.isArray(args) && args.find(arg => typeof arg === 'string' && arg.startsWith(`repos/${state.repository}/`));
      const merge = command === 'gh' && path === `repos/${state.repository}/pulls/${state.ticketAtCreation?.number}/merge` && args.includes('PUT');
      if (merge) {
        const inputIndex = args.indexOf('--input');
        const payload = inputIndex >= 0 ? JSON.parse(readFileSync(args[inputIndex + 1], 'utf8')) : {};
        state.mergeRequests.push({ sequence: ++state.sequence, sha: payload.sha, method: payload.merge_method });
        if (state.mode === 'base-race-after-final-read') advance('base');
      }
      if (command === 'gh' && path === `repos/${state.repository}/issues/${state.ticket}` && args.includes('PATCH')) {
        state.closeRequests.push({ sequence: ++state.sequence });
      }
      const stage = options?.env?.FLOW_STAGE;
      const projectCommand = Array.isArray(args) && args[0] === 'fixture.mjs' && ['candidate', 'actual'].includes(stage);
      if (projectCommand) state.commands.push({ phase: stage, command: args[1], sha: options.env.FLOW_CODE_SHA, sequence: ++state.sequence });
      const failAccept = projectCommand && args[1] === 'accept'
        && ((state.mode === 'accept-failure' && stage === 'candidate') || (state.mode === 'actual-merge-recheck-fails' && stage === 'actual'));
      const corruptDownload = state.mode === 'evidence-unavailable' && state.currentGate?.phase === 'candidate'
        && command === 'gh' && args[0] === 'release' && args[1] === 'download';
      if (!failAccept && !corruptDownload) return state.spawn.call(this, command, args, options);
      const script = fileURLToPath(new URL('./integration-fault-command.mjs', import.meta.url));
      const child = state.spawn.call(this, process.execPath, [script, state.mode, command, ...args], options);
      let captured = '';
      let counted = false;
      child.stdout?.on('data', chunk => {
        captured = `${captured}${chunk}`.slice(-4096);
        if (!counted && captured.includes(`INTEGRATION_FAULT_APPLIED: ${state.mode}`)) { counted = true; state.applied += 1; }
      });
      if (corruptDownload) {
        let diagnostic = '';
        child.stderr?.on('data', chunk => {
          diagnostic = `${diagnostic}${chunk}`.slice(-4096);
          const bytes = /INTEGRATION_FAULT_BYTES: (\{[^\n]*\})/.exec(diagnostic);
          if (bytes) state.byteFault = { ...JSON.parse(bytes[1]), tag: args[2],
            repository: args[args.indexOf('--repo') + 1], filename: args[args.indexOf('--pattern') + 1] };
          if (!counted && diagnostic.includes('INTEGRATION_FAULT_APPLIED: evidence-unavailable')) { counted = true; state.applied += 1; }
        });
      }
      return child;
    };
    syncBuiltinESMExports();
  }
  pi.registerCommand('fixture-integration', { handler: async (text, ctx) => {
    if (state.configured) throw new Error('Integration observer may only be configured once');
    const config = JSON.parse(text);
    if (config.repository !== 'nanzhi84/pi-implement-flow-acceptance' || ![config.spec, config.ticket].every(Number.isSafeInteger)
      || !['observe', 'accept-failure', 'evidence-unavailable', 'stale-head', 'stale-base', 'actual-merge-recheck-fails', 'base-race-after-final-read'].includes(config.mode)) throw new Error('Invalid isolated integration fixture');
    Object.assign(state, config, { cwd: ctx.cwd, feature: `flow/spec-${config.spec}`, configured: true });
    install(ctx);
  } });
  pi.registerCommand('fixture-integration-status', { handler: async (_args, ctx) => {
    const { mode, applied, gates, ticketAtCreation, featureAtCandidate, totalBeforeIntegration, mergeRequests, closeRequests, commands, writes, byteFault } = state;
    ctx.ui.notify(`INTEGRATION_OBSERVER: ${JSON.stringify({ mode, applied, gates, ticketAtCreation, featureAtCandidate, totalBeforeIntegration, mergeRequests, closeRequests, commands, writes, byteFault })}`, 'info');
  } });
  pi.on('session_shutdown', async () => {
    childProcess.spawn = state.spawn;
    if (state.ui?.notify === state.wrappedNotify) state.ui.notify = state.notify;
    syncBuiltinESMExports();
  });
}
