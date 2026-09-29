import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

// Opt-in OS/CLI fault injection. Production control and SDK code are untouched.
export default function ticketFaultBridge(pi) {
  const originalSpawn = childProcess.spawn;
  const wrapper = fileURLToPath(new URL('./ticket-fault-command.mjs', import.meta.url));
  const counters = { attempts: 0, applied: 0 };
  let armed;
  const restore = () => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); };
  pi.registerCommand('fixture-ticket-fault', { handler: async (phase, ctx) => {
    if (armed || !['prepare-drift', 'cleanup-drift', 'push-unknown'].includes(phase)) throw new Error('Exactly one explicit Ticket fault may be armed');
    armed = phase;
    childProcess.spawn = function (command, args, options) {
      const ticketWorkspace = typeof options?.cwd === 'string'
        && /[/\\]flow-tickets[/\\]spec-\d+[/\\]ticket-\d+[/\\]worktree$/.test(options.cwd);
      const targetPhase = phase === 'prepare-drift' ? 'prepare' : 'cleanup';
      const projectCommand = ticketWorkspace && Array.isArray(args) && args[0] === 'fixture.mjs' && args[1] === targetPhase;
      const featurePush = command === 'git' && Array.isArray(args) && args[0] === 'push'
        && args.some(arg => /^[a-f0-9]{40}:refs\/heads\/flow\/spec-\d+$/.test(arg));
      const selected = phase === 'push-unknown' ? featurePush : projectCommand;
      if (!selected) return originalSpawn.call(this, command, args, options);
      counters.attempts += 1;
      const child = originalSpawn.call(this, process.execPath, [wrapper, phase, command, ...args], options);
      let observed = '';
      let counted = false;
      child.stdout?.on('data', chunk => {
        observed = `${observed}${chunk.toString()}`.slice(-4096);
        if (!counted && observed.includes(`TICKET_FAULT_APPLIED: ${phase}`)) {
          counted = true;
          counters.applied += 1;
          ctx.ui.notify(`FAULT_APPLIED: ${phase}; real command completed before injection`, 'info');
        }
      });
      return child;
    };
    syncBuiltinESMExports();
    ctx.ui.notify(`FAULT_ARMED: ${phase}`, 'info');
  } });
  pi.registerCommand('fixture-ticket-fault-status', { handler: async (_args, ctx) => {
    ctx.ui.notify(`FAULT_COUNTS: ${JSON.stringify({ phase: armed, ...counters })}`, 'info');
  } });
  pi.on('session_shutdown', restore);
}
