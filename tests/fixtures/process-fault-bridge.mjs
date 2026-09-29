import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// System-boundary fault injection only: after a real owned command exits, model
// a kernel/process-visibility result that cannot establish group quiescence.
// This is NOT evidence of a real unkillable kernel process on the test machine.
export default function processFaultBridge(pi) {
  const originalSpawn = childProcess.spawn;
  const originalKill = process.kill;
  const owned = new Set();
  const restore = () => {
    childProcess.spawn = originalSpawn;
    process.kill = originalKill;
    syncBuiltinESMExports();
  };
  pi.registerCommand('fixture-process-fault', {
    handler: async (phase, ctx) => {
      if (!['cleanup', 'publish'].includes(phase)) throw new Error('Explicit fixture phase required');
      childProcess.spawn = function (command, args, ...rest) {
        const child = originalSpawn.call(this, command, args, ...rest);
        const selected = Array.isArray(args) && (phase === 'cleanup'
          ? args[0] === 'fixture.mjs' && args[1] === 'cleanup'
          : args[0] === 'publish.mjs');
        if (selected && child.pid) {
          owned.add(child.pid);
          child.once('close', () => ctx.ui.notify(`FAULT_CHILD_CLOSED: ${phase}; only liveness observation is injected`, 'info'));
        }
        return child;
      };
      process.kill = function (pid, signal) {
        if (signal === 0 && owned.has(-pid)) return true;
        return originalKill.call(process, pid, signal);
      };
      syncBuiltinESMExports();
    },
  });
  pi.on('session_shutdown', restore);
}
