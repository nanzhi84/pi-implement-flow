import { spawnSync } from 'node:child_process';
const [mode, command, ...args] = process.argv.slice(2);
if (!['accept-failure', 'actual-merge-recheck-fails', 'evidence-unavailable'].includes(mode) || !command) process.exit(97);
const result = spawnSync(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
if (result.error || result.signal || result.status !== 0) process.exit(result.status || 98);
if (mode === 'evidence-unavailable') {
  process.stdout.write(result.stdout + '\nINTEGRATION_FAULT_APPLIED: evidence-unavailable\n');
} else {
  process.stdout.write(`INTEGRATION_FAULT_APPLIED: ${mode}\n`);
  process.exitCode = 1; // The real assertion command ran; its caller observes failure.
}
