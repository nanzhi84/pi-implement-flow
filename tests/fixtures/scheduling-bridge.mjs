import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertRepositoryIdentity, repository } from '../acceptance-repository.mjs';

export default function bridge(pi) {
  const originalSpawn = childProcess.spawn; let installed = false; let notify; let ui; let config; let unknownRef; let queue = Promise.resolve(); let failure;
  let readSerial = 0; let stage = { kind: 'preflight' };
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
    ui.notify = function(message, ...args) {
      const gate = /^(GATE_STARTED|GATE_PASSED): (candidate|actual) ([a-f0-9]{40})\b/.exec(message);
      if (gate) stage = { kind: gate[1], phase: gate[2], sha: gate[3] };
      if (/^(FLOW_ACTIVITY|FLOW_RESOURCE|FLOW_TICKET_STATE|TICKET_STARTED|TICKET_PR|TICKET_DELIVERED|GATE_STARTED|GATE_PASSED|REVIEW_FINDINGS):/.test(message)) event({ type: 'notice', message });
      return notify.call(this, message, ...args);
    };
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
          else unknownRef = target.split(':').at(-1); // Arm before spawn; applied evidence still requires independent readback.
          const child = originalSpawn.call(this, process.execPath,
            [script, blockReadback ? 'readback-unavailable' : 'push-unknown', config.url, String(config.tickets[0]), command, ...args], options);
          return child;
        }
      }
      if (command === 'gh' && args[0] === 'api') {
        const path = args.find(value => typeof value === 'string' && value.startsWith(`repos/${repository}/`));
        if (['POST', 'PATCH', 'PUT', 'DELETE'].some(method => args.includes(method))) event({ type: 'github-write', path });
        if (path === `repos/${repository}/pulls` && args.includes('POST')) event({ type: 'pull-create' });
        if (path?.endsWith('/merge') && args.includes('PUT')) event({ type: 'merge', pr: Number(path.split('/').at(-2)) });
        if (/\/issues\/\d+$/.test(path ?? '') && args.includes('PATCH')) event({ type: 'close', ticket: Number(path.split('/').at(-1)) });
        const methodIndex = args.indexOf('--method');
        const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1];
        const repoPath = args.find(value => typeof value === 'string' && (value === `repos/${repository}` || value.startsWith(`repos/${repository}/`)));
        const publicPath = repoPath?.split('?')[0];
        const [owner, name] = repository.split('/');
        const protection = args.includes('graphql') && args.includes(`owner=${owner}`) && args.includes(`name=${name}`)
          && args.some(value => value.startsWith('query=query(') && value.includes('branchProtectionRules'));
        if ((method === 'GET' && publicPath && /^[A-Za-z0-9/_%.-]{1,512}$/.test(publicPath)) || protection) {
          const observation = { type: 'github-read', id: ++readSerial, path: protection ? 'graphql:branchProtectionRules' : publicPath, stage: { ...stage } };
          event({ ...observation, event: 'start' });
          const child = originalSpawn.call(this, command, args, options);
          child.once('error', () => event({ ...observation, event: 'spawn-error' }));
          child.once('close', (exitCode, signal) => event({ ...observation, event: 'end', exitCode, signal }));
          return child;
        }
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
