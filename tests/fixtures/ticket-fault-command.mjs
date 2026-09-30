import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Runs only as the test bridge's real child process, in the original process
// group. Never rewrites the fixture command or simulates a successful Git push.
const [phase, command, ...args] = process.argv.slice(2);
if (phase === 'push-query-unavailable') process.exit(1);
if (!['prepare-drift', 'cleanup-drift', 'push-unknown'].includes(phase) || !command) process.exit(97);
const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
if (result.error || result.signal || result.status !== 0) process.exit(result.status || 98);
if (phase === 'push-unknown') {
  process.stdout.write('TICKET_FAULT_APPLIED: push-unknown\n');
  process.exit(1); // The real push succeeded, but its calling client sees failure.
}
appendFileSync(join(process.cwd(), 'app.mjs'), `\n// Synthetic Ticket ${phase} fault.\n`);
process.stdout.write(`TICKET_FAULT_APPLIED: ${phase}\n`);
