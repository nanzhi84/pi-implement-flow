import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
const [mode, url, ticketText, command, ...args] = process.argv.slice(2);
if (mode === 'readback-unavailable') {
  process.stderr.write('Synthetic exact-ref readback unavailable: unexpected EOF\n'); process.exitCode = 1;
} else if (mode === 'push-unknown' && command === 'git' && args[0] === 'push') {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  if (exit.code !== 0 || exit.signal) { process.stderr.write('Unknown-push fixture precondition failed\n'); process.exitCode = exit.code || 1; }
  else {
    const target = args.find(value => /^[a-f0-9]{40}:refs\/heads\/flow\/ticket-\d+-\d+$/.test(value));
    if (!target) throw new Error('Exact synthetic target required');
    const [sha, ref] = target.split(':');
    const actual = execFileSync('git', ['ls-remote', '--heads', 'origin', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim().split(/\s+/)[0];
    if (actual !== sha) throw new Error('Actual remote write must precede fault injection');
    const observed = { ticket: Number(ticketText), branch: ref.slice('refs/heads/'.length), sha };
    const response = await fetch(`${url}/unknown-applied`, { method: 'POST', body: JSON.stringify(observed) });
    if (!response.ok) throw new Error('Observer did not accept actual push evidence');
    process.stdout.write(`SCHEDULING_PUSH_APPLIED: ${JSON.stringify(observed)}\n`);
    process.stderr.write('Synthetic unknown push result after confirmed remote write\n'); process.exitCode = 1;
  }
} else throw new Error('Unsupported isolated push fault');
