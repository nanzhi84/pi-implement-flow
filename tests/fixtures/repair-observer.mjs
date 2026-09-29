import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { repository, assertRepositoryIdentity } from '../acceptance-repository.mjs';

// Read-only observation at real UI and process boundaries, scoped to one Ticket.
export default function repairObserver(pi) {
  const original = childProcess.spawn;
  let config; let ui; let notify;
  const heads = new Set(); const gates = []; const mergeRequests = []; const closeRequests = [];
  const started = []; const barrierErrors = []; const barriers = [];
  const candidateWaits = []; const deferredReads = [];
  let lastFailedCandidate; let pendingReads = 0; let repairedHead; let armed = false;
  let targetPr;
  const run = (command, args) => childProcess.execFileSync(command, args, { cwd: config.cwd,
    encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  pi.registerCommand('fixture-repair-observe', { handler: async (source, ctx) => {
    if (config) throw new Error('Observer config is single use');
    const value = JSON.parse(source);
    if (value.repository !== repository || repository !== 'nanzhi84/pi-implement-flow-repair-acceptance'
      || ![value.spec, value.ticket].every(item => Number.isSafeInteger(item) && item > 0)) throw new Error('Invalid isolated observer');
    if (value.upstream !== undefined && (!Number.isSafeInteger(value.upstream) || value.upstream <= 0
      || !/^http:\/\/127\.0\.0\.1:\d+\/_fixture\/upstream-submitted$/.test(value.barrierUrl))) throw new Error('Invalid isolated upstream barrier');
    config = { ...value, cwd: ctx.cwd };
    if (run('git', ['remote', 'get-url', 'origin']) !== `https://github.com/${repository}.git`) throw new Error('Fixture origin mismatch');
    assertRepositoryIdentity(JSON.parse(run('gh', ['api', `repos/${repository}`])));
    ui = ctx.ui; notify = ui.notify;
    ui.notify = (message, ...args) => {
      if (String(message).startsWith('TICKET_STARTED: ')) started.push(JSON.parse(String(message).slice('TICKET_STARTED: '.length)));
      const created = /^TICKET_PR: https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(message);
      if (created) {
        const pr = JSON.parse(run('gh', ['api', `repos/${repository}/pulls/${created[1]}`]));
        if (pr.head.ref === `flow/ticket-${config.spec}-${config.ticket}`) { targetPr = pr.number; heads.add(pr.head.sha); }
      }
      if (config.upstream && String(message).startsWith('FLOW_TICKET_STATE: ')) {
        const state = JSON.parse(String(message).slice('FLOW_TICKET_STATE: '.length));
        if (state.ticket === config.upstream && state.state === 'submitted') {
          const branch = `flow/ticket-${config.spec}-${config.upstream}`;
          const ref = JSON.parse(run('gh', ['api', `repos/${repository}/git/ref/heads/${branch}`]));
          if (ref.ref !== `refs/heads/${branch}` || ref.object.type !== 'commit' || !/^[a-f0-9]{40}$/.test(ref.object.sha)) throw new Error('Submitted upstream head is not independently observable');
          barriers.push(fetch(config.barrierUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket: config.upstream, state: 'submitted', head: ref.object.sha }), signal: AbortSignal.timeout(30_000) })
            .then(result => { if (result.status !== 204) throw new Error('Barrier refused'); })
            .catch(() => { barrierErrors.push('Upstream submission could not reach the isolated model barrier'); }));
        }
      }
      const failed = /^GATE_FAILED: candidate ([a-f0-9]{40})/.exec(message);
      if (failed) lastFailedCandidate = failed[1];
      const repaired = new RegExp(`^TICKET_REPAIRED: #${config.ticket} [a-f0-9]{40} ([a-f0-9]{40})`).exec(message);
      if (repaired) {
        heads.add(repaired[1]);
        if (config.deferCandidate && !armed) { armed = true; pendingReads = 2; repairedHead = repaired[1]; }
      }
      const waiting = new RegExp(`^CANDIDATE_WAIT: #${config.ticket} ([a-f0-9]{40}) ([a-f0-9]{40})$`).exec(message);
      if (waiting) candidateWaits.push({ H: waiting[1], B: waiting[2] });
      const passed = /^GATE_PASSED: (candidate|actual) ([a-f0-9]{40}) (https:\/\/github\.com\/\S+)/.exec(message);
      if (passed) {
        const parents = run('git', ['show', '-s', '--format=%P', passed[2]]).split(' ');
        if (heads.has(parents[1])) gates.push({ phase: passed[1], sha: passed[2], url: passed[3] });
      }
      return notify.call(ui, message, ...args);
    };
    childProcess.spawn = function (command, args, options) {
      const path = args?.find(item => typeof item === 'string' && item.startsWith(`repos/${repository}/`));
      if (pendingReads && command === 'gh' && path === `repos/${repository}/pulls/${targetPr}`
        && args[args.indexOf('--method') + 1] === 'GET') {
        pendingReads -= 1;
        deferredReads.push({ H: repairedHead, oldC: lastFailedCandidate });
        return original.call(this, process.execPath, [fileURLToPath(new URL('./repair-read-command.mjs', import.meta.url)), ...args], {
          ...options, env: { ...options.env, FLOW_FIXTURE_PR: String(targetPr), FLOW_FIXTURE_HEAD: repairedHead, FLOW_FIXTURE_OLD_C: lastFailedCandidate },
        });
      }
      if (command === 'gh' && path === `repos/${repository}/pulls/${targetPr}/merge` && args.includes('PUT')) {
        const index = args.indexOf('--input'); const payload = JSON.parse(readFileSync(args[index + 1], 'utf8'));
        mergeRequests.push({ sha: payload.sha, method: payload.merge_method });
      }
      if (command === 'gh' && path === `repos/${repository}/issues/${config.ticket}` && args.includes('PATCH')) closeRequests.push({ ticket: config.ticket });
      return original.call(this, command, args, options);
    };
    syncBuiltinESMExports();
  } });
  pi.registerCommand('fixture-repair-observe-status', { handler: async (_source, ctx) => {
    await Promise.all(barriers);
    ctx.ui.notify(`REPAIR_OBSERVER: ${JSON.stringify({ gates, mergeRequests, closeRequests, started, barrierErrors, candidateWaits, deferredReads })}`, 'info');
  } });
  pi.on('session_shutdown', async () => { childProcess.spawn = original; if (ui) ui.notify = notify; syncBuiltinESMExports(); });
}
