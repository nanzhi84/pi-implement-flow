import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

// Opt-in OS/CLI fault injection. Production control and SDK code are untouched.
export default function ticketFaultBridge(pi) {
  // pi can rebuild extension factories during new_session. Preserve only this
  // test observer in the same OS process, never as persisted recovery state.
  const key = Symbol.for('pi-implement-flow.test.ticket-fault-observer.v1');
  const state = globalThis[key] ??= {
    originalSpawn: childProcess.spawn, phase: undefined, attempts: 0, applied: 0,
    commandWrapper: fileURLToPath(new URL('./ticket-fault-command.mjs', import.meta.url)),
    spawnWrapper: undefined, notify: undefined,
  };
  if (!state.spawnWrapper) {
    state.spawnWrapper = function (command, args, options) {
      const phase = state.phase;
      const ticketWorkspace = typeof options?.cwd === 'string'
        && /[/\\]flow-tickets[/\\]spec-\d+[/\\]ticket-\d+[/\\]worktree$/.test(options.cwd);
      const targetPhase = phase === 'prepare-drift' ? 'prepare' : 'cleanup';
      const projectCommand = ticketWorkspace && Array.isArray(args) && args[0] === 'fixture.mjs' && args[1] === targetPhase;
      const featurePush = command === 'git' && Array.isArray(args) && args[0] === 'push'
        && args.some(arg => /^[a-f0-9]{40}:refs\/heads\/flow\/spec-\d+$/.test(arg));
      const selected = phase && (phase === 'push-unknown' ? featurePush : projectCommand);
      if (!selected) return state.originalSpawn.call(this, command, args, options);
      state.attempts += 1;
      // Capture native spawn once. Factory reconstruction never wraps a wrapper.
      const child = state.originalSpawn.call(this, process.execPath, [state.commandWrapper, phase, command, ...args], options);
      let observed = '';
      let counted = false;
      child.stdout?.on('data', chunk => {
        observed = `${observed}${chunk.toString()}`.slice(-4096);
        if (!counted && observed.includes(`TICKET_FAULT_APPLIED: ${phase}`)) {
          counted = true;
          state.applied += 1;
          state.notify?.(`FAULT_APPLIED: ${phase}; real command completed before injection`);
        }
      });
      return child;
    };
  }
  const install = () => {
    if (!state.phase) return;
    childProcess.spawn = state.spawnWrapper;
    syncBuiltinESMExports();
  };
  const bindContext = ctx => { state.notify = message => ctx.ui.notify(message, 'info'); };
  const restore = () => {
    state.notify = undefined;
    if (childProcess.spawn === state.spawnWrapper) childProcess.spawn = state.originalSpawn;
    syncBuiltinESMExports();
  };
  install(); // Reconstructed factories resume the same armed observer.
  pi.registerCommand('fixture-ticket-fault', { handler: async (phase, ctx) => {
    if (state.phase || !['prepare-drift', 'cleanup-drift', 'push-unknown'].includes(phase)) throw new Error('Exactly one explicit Ticket fault may be armed');
    state.phase = phase;
    bindContext(ctx);
    install();
    ctx.ui.notify(`FAULT_ARMED: ${phase}`, 'info');
  } });
  pi.registerCommand('fixture-ticket-fault-status', { handler: async (_args, ctx) => {
    bindContext(ctx);
    ctx.ui.notify(`FAULT_COUNTS: ${JSON.stringify({ phase: state.phase, attempts: state.attempts, applied: state.applied })}`, 'info');
  } });
  pi.on('session_start', async (_event, ctx) => { bindContext(ctx); install(); });
  pi.on('session_shutdown', restore);
}
