import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertRepositoryIdentity, repository } from '../acceptance-repository.mjs';

export default function bridge(pi) {
  const originalSpawn = childProcess.spawn; let installed = false; let notify; let ui; let config; let unknownRef; let queue = Promise.resolve(); let failure;
  const event = value => {
    queue = queue.then(async () => { const result = await fetch(`${config.url}/event`, { method: 'POST', body: JSON.stringify(value) }); if (!result.ok) throw new Error('Observer rejected event'); }).catch(error => { failure = error; });
  };
  pi.registerCommand('fixture-scheduling', { handler: async (text, ctx) => {
    if (installed) throw new Error('Scheduling observer can only be armed once');
    config = JSON.parse(text);
    if (config.repository !== repository || !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.url)
      || !Array.isArray(config.tickets) || config.tickets.some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid observer configuration');
    const run = (cmd, args) => childProcess.execFileSync(cmd, args, { cwd: ctx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (run('git', ['remote', 'get-url', 'origin']) !== `https://github.com/${repository}.git`) throw new Error('Wrong isolated repository');
    assertRepositoryIdentity(JSON.parse(run('gh', ['api', `repos/${repository}`])));
    installed = true; ui = ctx.ui; notify = ui.notify;
    ui.notify = function(message, ...args) { if (/^(FLOW_ACTIVITY|FLOW_RESOURCE|FLOW_TICKET_STATE|TICKET_STARTED|TICKET_PR|TICKET_DELIVERED|GATE_STARTED|GATE_PASSED|REVIEW_FINDINGS):/.test(message)) event({ type: 'notice', message }); return notify.call(this, message, ...args); };
    childProcess.spawn = function(command, args, options) {
      const ticket = Number(options?.env?.FLOW_TICKET); const phase = options?.env?.FLOW_STAGE;
      const projectCommand = Array.isArray(args) && args[0] === 'fixture.mjs' && config.tickets.includes(ticket);
      const gitPush = command === 'git' && args[0] === 'push';
      if (gitPush) event({ type: 'git-write', operation: 'push' });
      if (config.scenario === 'parallel-unknown-retains-cleanup' && command === 'git') {
        const target = args.find(value => typeof value === 'string' && value.endsWith(`:refs/heads/flow/ticket-${config.spec}-${config.tickets[0]}`));
        const blockReadback = unknownRef && args[0] === 'ls-remote' && args.includes(unknownRef);
        if ((gitPush && target) || blockReadback) {
          const script = fileURLToPath(new URL('./scheduling-push-fault.mjs', import.meta.url));
          if (blockReadback) event({ type: 'unknown-readback-refused', ref: unknownRef });
          const child = originalSpawn.call(this, process.execPath,
            [script, blockReadback ? 'readback-unavailable' : 'push-unknown', config.url, String(config.tickets[0]), command, ...args], options);
          if (!blockReadback) {
            let output = '';
            child.stdout?.on('data', chunk => { output += chunk; const match = /SCHEDULING_PUSH_APPLIED: (\{[^\n]+\})/.exec(output);
              if (match) unknownRef = `refs/heads/${JSON.parse(match[1]).branch}`; });
          }
          return child;
        }
      }
      if (command === 'gh' && args[0] === 'api') {
        const path = args.find(value => typeof value === 'string' && value.startsWith(`repos/${repository}/`));
        if (['POST', 'PATCH', 'PUT', 'DELETE'].some(method => args.includes(method))) event({ type: 'github-write', path });
        if (path?.endsWith('/merge') && args.includes('PUT')) event({ type: 'merge', pr: Number(path.split('/').at(-2)) });
        if (/\/issues\/\d+$/.test(path ?? '') && args.includes('PATCH')) event({ type: 'close', ticket: Number(path.split('/').at(-1)) });
      }
      if (!projectCommand) return originalSpawn.call(this, command, args, options);
      const item = { type: 'command', ticket, phase, command: args[1], sha: options.env.FLOW_CODE_SHA };
      event({ ...item, event: 'start' });
      const script = fileURLToPath(new URL('./scheduling-command.mjs', import.meta.url));
      const child = originalSpawn.call(this, process.execPath, [script, config.url, config.scenario, command, ...args],
        { ...options, env: { ...options.env, FLOW_PAIR_TICKETS: config.tickets.slice(0, 2).join(',') } });
      child.once('close', (exitCode, signal) => event({ ...item, event: 'end', exitCode, signal }));
      return child;
    };
    syncBuiltinESMExports();
  } });
  pi.registerCommand('fixture-scheduling-flush', { handler: async () => { await queue; if (failure) throw failure; } });
  pi.on('session_shutdown', async () => { childProcess.spawn = originalSpawn; if (ui) ui.notify = notify; syncBuiltinESMExports(); await queue; });
}
